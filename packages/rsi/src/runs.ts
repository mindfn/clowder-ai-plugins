import { executionParameters, fingerprint } from './parameters.js';
import { tierEvidence } from './tiers.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { finishCycle, settleAbort } from './cycles.js';
import { normalizeSlicesInput, roundMetrics } from './compare.js';
import { message, recordInitExecution, submitInitStep } from './init.js';
import { insideWindow } from './schedule.js';
import { clip, listOwners, LOG_KEEP, record, retain, readState, isState } from './store.js';
import { projectCommit, projectRevision, removeVersionWorktrees, versionDirectory } from './versions.js';
import type { Data, RsiHost } from './types.js';

// A registered command runs in the host system's shell, like any spawned command: sh, or cmd on Windows. What it does is the members' business.
class EvidenceBlocked extends Error {}
const windows = platform() === 'win32';
export const quote = (value: string | number, win = windows) => win ? `"${String(value).replace(/"/g, '""')}"` : `'${String(value).replace(/'/g, `'"'"'`)}'`;
// A stopped command takes what it started with it: its process group, or its process tree on Windows.
function killTree(pid: number) {
  if (windows) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else process.kill(-pid, 'SIGKILL');
}
const render = (command: string, values: Data) => command.replace(/\{(config|run|seed|job|start|end|harness|version|commit)\}/g, (_, k) => quote(values[k] ?? ''));
const canCancel = (tpl: string | undefined, values: Data | undefined) => !!tpl && !!values && (!!values.job || !tpl.includes('{job}'));
const field = (value: Data, path: string) => path.split('.').reduce((v: any, k) => v?.[k], value);
const exists = (path: string) => stat(path).then(() => true, () => false);
const parseResult = (raw: string) => JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|\bNaN\b|-?Infinity\b/g, (token) => token.startsWith('"') ? token : JSON.stringify(token)));
export const pollGraceWindowMs = (timeoutSec: number | null | undefined) =>
  timeoutSec && timeoutSec >= 60 ? Math.min(600_000, Math.max(60_000, Math.floor(timeoutSec * 1000 * 0.25))) : 0;
function parseStructuredOutput(raw: string | undefined): Data | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  if (lines.length) candidates.push(lines[lines.length - 1]);
  for (const s of candidates) {
    if (!s.startsWith('{')) continue;
    try {
      const parsed = parseResult(s);
      if (record(parsed)) return parsed;
    } catch {}
  }
  return null;
}
function isNonRetryableOutput(raw: string | undefined): boolean {
  const parsed = parseStructuredOutput(raw);
  return !!parsed && (parsed.retryable === false || parsed.errorKind === 'real' || parsed.failureKind === 'real');
}
function isRetryableOutput(raw: string | undefined): boolean {
  const parsed = parseStructuredOutput(raw);
  return !!parsed && parsed.retryable === true;
}

export function createRuns(host: RsiHost, changed: (key: string) => Promise<void>) {
  let stopped = false, again = false, held = false, aborting = false, child: ChildProcess | undefined, job: Promise<void> | undefined, remote: Data | undefined;
  let awaitingJobId = false, asyncSubmitBounded = false, abortSubmitTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, releasePoll: (() => void) | undefined;
  // busy: the objective whose probe or run is executing, runId: that run; a deleted (dropped) objective starts no further command.
  let busy: string | undefined, runId: string | undefined;
  const dropped = new Set<string>();
  // limit (ms): a command still running then is stopped with its process group.
  async function command(template: string, cwd: string, values: Data, limit = 0) {
    if (busy && dropped.has(busy)) return { code: -1, log: 'Objective deleted', stdout: '', timedOut: false };
    let log = '', stdout = '', expired = false;
    const MAX_STDOUT = 4 * 1024 * 1024;
    const process = child = spawn(render(template, values), { cwd, shell: true, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout!.on('data', (part) => { if (stdout.length < MAX_STDOUT) stdout = (stdout + part).slice(0, MAX_STDOUT); log = (log + part).slice(-16000); });
    process.stderr!.on('data', (part) => { log = (log + part).slice(-16000); });
    const timer = limit ? setTimeout(() => {
      expired = true;
      log += `\n超过 ${Math.round(limit / 1000)} 秒没结束，已停止`;
      if (process.pid && process.exitCode === null && process.signalCode === null) {
        try { killTree(process.pid); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH' && code !== 'EPERM') host.log('error', 'RSI could not stop a timed-out command', { error: String(error) });
        }
      }
    }, limit) : undefined;
    const code = await new Promise<number>((done) => {
      process.once('error', (error) => { log += error.message; done(-1); });
      process.once('close', (exit, signal) => { if (signal) log += `\n${signal}`; done(exit ?? -1); });
    });
    clearTimeout(timer);
    if (child === process) child = undefined;
    return { code, log, stdout, timedOut: expired };
  }

  // The work loop starts no command once the plugin stops (stop() would otherwise wait for it to finish; stop() itself may still cancel a job) or its run is held.
  const launch = (template: string, cwd: string, values: Data, limit = 0) => stopped || held || aborting ? Promise.resolve({ code: -1, log: aborting ? 'Cycle aborted' : held ? 'Run window closed' : 'Plugin stopped', stdout: '', timedOut: false }) : command(template, cwd, values, limit);

  async function work() {
    while (!stopped) {
      busy = runId = undefined; held = aborting = false;
      const owners = await listOwners(host.storage);
      const cancellation = owners.flatMap(([key, entry]) => Object.values(entry.value.experiments)
        .filter((d) => d.objective.projectPath).flatMap((d) => d.rounds.filter((r: Data) => r.state === 'aborting').map((round: Data) => ({ key, d, round }))))[0];
      if (cancellation) {
        const { key, d, round } = cancellation;
        busy = d.objective.id;
        for (const run of round.runs.filter((r: Data) => r.cancelResult?.status === 'pending')) {
          if (stopped) return;
          // New runs freeze their exact command arguments; legacy persisted jobs use the recorded run directory/env.
          const execution = run.execution || { cwd: run.cwd || d.objective.projectPath, cancel: d.executor.commands.cancel,
            values: { config: join(run.directory || '', 'config.json'), run: run.directory || '', seed: run.seed,
              start: Math.floor((run.start || round.start) / 1000), job: run.jobId || '',
              harness: d.versions.find((v: Data) => v.id === run.env?.harness?.version)?.worktree || run.cwd || d.objective.projectPath,
              version: round.plan.groups.find((g: Data) => g.id === run.group)?.version || '', commit: run.env?.commit || '' } };
          const values = { ...execution.values, job: run.jobId || execution.values.job, end: Math.floor(Date.now() / 1000) };
          let result: Data;
          if (execution.submitted === false) result = { status: 'notSubmitted', at: Date.now() };
          else if (canCancel(execution.cancel, values)) {
            const cancelled = await command(execution.cancel, execution.cwd, values, 30_000);
            if (stopped) return;
            result = { status: cancelled.code === 0 ? 'cancelled' : 'failed', code: cancelled.code, log: cancelled.log.slice(-LOG_KEEP), at: Date.now() };
          } else result = { status: run.jobId || d.executor.commands.get ? 'unconfirmed' : 'localStopped', at: Date.now() };
          await retain(host.storage, key, (state) => {
            const current = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
            if (!current) return;
            current.cancelResult = result;
            if (result.status === 'cancelled') delete current.jobId;
          });
        }
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (current) settleAbort(state, current, current.rounds.find((r: Data) => r.n === round.n), Date.now());
        });
        await changed(key);
        continue;
      }
      const retired = owners.flatMap(([key, entry]) => Object.values(entry.value.experiments)
        .filter((d) => d.objective.projectPath && ['done', 'retired'].includes(d.objective.state) && d.versions.some((v: Data) => v.worktree)).map((d) => ({ key, d })))[0];
      if (retired) {
        await removeVersionWorktrees(retired.d);
        await retain(host.storage, retired.key, (state) => { for (const v of state.experiments[retired.d.objective.id]?.versions || []) delete v.worktree; });
        continue;
      }
      const probe = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && d.executor.state === 'probing' && d.exec?.run?.state === 'started')
        .map((d) => ({ key, d })))[0];
      if (probe) {
        const { key, d } = probe, executionId = d.exec!.run!.id;
        busy = d.objective.id;
        const probeVersion = d.versions.find((v: Data) => v.id === d.objective.currentVersion && v.commit);
        const probeCwd = probeVersion ? (await versionDirectory(host, key, d, probeVersion)).cwd : d.objective.projectPath;
        const latestVersion = [...d.versions].reverse().find((v: Data) => v.commit);
        const harnessDir = latestVersion
          ? (latestVersion.id === probeVersion?.id ? probeCwd : (await versionDirectory(host, key, d, latestVersion)).cwd)
          : probeCwd;
        const result = await launch(d.executor.commands.preflight, probeCwd, {
          config: '', run: '', seed: 0, job: '', start: Math.floor(Date.now() / 1000),
          harness: harnessDir, version: probeVersion?.id || '', commit: probeVersion?.commit || '',
        });
        const commit = await projectCommit(d.objective.projectPath);
        if (stopped) return;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (current?.exec?.run?.id !== executionId || current.executor.state !== 'probing') return;
          if (probeVersion?.commit) { const pv = current.versions.find((v: Data) => v.id === probeVersion.id); if (pv) pv.worktree = probeCwd; }
          if (latestVersion?.commit) { const lv = current.versions.find((v: Data) => v.id === latestVersion.id); if (lv) lv.worktree = harnessDir; }
          current.executor.state = result.code === 0 ? 'passed' : 'failed';
          current.executor.probe = { at: Date.now(), error: result.code === 0 ? null : clip(result.log || `exit ${result.code}`), log: result.log.slice(-LOG_KEEP) };
          const initial = current.versions.find((v: Data) => v.snapshot);
          if (result.code === 0 && initial) { initial.commit = commit; delete initial.snapshot; }
          const pending = current.executor.pending;
          delete current.executor.pending;
          if (result.code !== 0) recordInitExecution(state, d.objective.id, 'run', executionId, 'failed', Date.now(), { reason: current.executor.probe.error });
          else if (pending) submitInitStep(state, d.objective.id, { ...pending, executor: current.executor }, Date.now());
        });
        await changed(key);
        continue;
      }
      const queued = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && d.objective.state === 'running')
        // A cycle the schedule started runs only inside its window.
        .flatMap((d) => d.rounds.filter((r: Data) => r.state === 'running' && (!r.scheduled || insideWindow(d.policy.schedule, Date.now()))).flatMap((round: Data) => round.runs.filter((run: Data) => run.state === 'queued').map((run: Data) => ({ key, d, round, run })))))
        // The cycle that started first runs first, whichever objective it belongs to.
        .sort((x, y) => x.round.start - y.round.start)[0];
      if (!queued) return;
      const { key, d, round, run } = queued;
      let executor = structuredClone(d.executor);
      const group = round.plan.groups.find((g: Data) => g.id === run.group), version = d.versions.find((v: Data) => v.id === group.version);
      const directory = join(d.objective.projectPath, 'runs', d.objective.id, String(round.n), `${group.id}-s${run.seed}`);
      // A persisted async job keeps the start of the attempt that submitted it: its {start} and timeout count from there.
      const configFile = join(directory, 'config.json'), start = run.jobId ? run.start : Date.now();
      busy = d.objective.id; runId = run.id;
      let acquired = false;
      await retain(host.storage, key, (state) => {
        acquired = false;
        const objective = state.experiments[d.objective.id], current = objective?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
        if (objective?.objective.state !== 'running' || objective.rounds.find((r: Data) => r.n === round.n)?.state !== 'running' || current?.state !== 'queued') return;
        acquired = true;
        Object.assign(current, { state: 'running', start, end: null, directory });
      });
      if (!acquired || stopped || aborting) continue;
      busy = d.objective.id; runId = run.id;
      const priorEnv = run.jobId ? (run.attempts?.slice().reverse().find((a: Data) => a.jobId === run.jobId && record(a.env))?.env || (record(run.env) ? run.env : null)) : null;
      let metrics: Data = {}, slices: Data | undefined, env: Data = { ...(priorEnv || {}), seed: run.seed, hardware: { os: `${platform()} ${release()}`, arch: arch(), chip: cpus()[0]?.model || 'unknown' } };
      let log = '', error: string | undefined, kind = 'env', step = 'prepare', jobId = run.jobId, timedOut = false, pollLost = false, pollLostRetryable = false, collectRetryable = false, remoteEnded = false, submitted = !!jobId;
      // The foreground submit's limit: the registered timeout, else three times this objective's longest successful attempt (at least 10 minutes); none before one has succeeded.
      const succeeded = d.rounds.flatMap((r: Data) => r.runs.flatMap((x: Data) => (x.attempts || []).filter((a: Data) => !a.error).map((a: Data) => a.end - a.start)));
      let limit = executor.timeout ? executor.timeout * 1000 : succeeded.length ? Math.max(600_000, 3 * Math.max(...succeeded)) : 0;
      let where: { cwd: string; values: Data } | undefined = run.jobId && run.execution ? { cwd: run.execution.cwd, values: { ...run.execution.values, job: run.jobId } } : undefined;
      try {
        let cwd: string, values: Data, context: Data;
        const verifyContext = async () => {
          const bytes = await readFile(context.values.config, 'utf8').catch(() => '');
          if (fingerprint(bytes) !== context.configHash) throw new EvidenceBlocked('Original submitted config is missing or changed; rescreen before adopting evidence');
          if (run.jobId && context.tracked && !run.parameters) throw new EvidenceBlocked('Original execution fingerprint is unavailable; evidence cannot be recovered');
          if (context.tracked && (await projectRevision(context.cwd) !== context.revision
            || context.usesHarness && await projectRevision(context.values.harness) !== context.harnessRevision)) {
            throw new EvidenceBlocked('Original execution checkout or measurement harness changed; evidence cannot be recovered');
          }
        };
        if (jobId) {
          const ref = run.execution?.context;
          if (!ref) throw new EvidenceBlocked('Original execution context is unavailable; evidence cannot be recovered');
          const bytes = await readFile(ref.path, 'utf8').catch(() => '');
          if (fingerprint(bytes) !== ref.hash) throw new EvidenceBlocked('Original execution context is missing or changed; evidence cannot be recovered');
          context = JSON.parse(bytes);
          executor = context.executor; limit = context.limit; cwd = context.cwd;
          values = { ...context.values, job: jobId }; where = { cwd, values };
          await verifyContext();
        } else {
          const located = await versionDirectory(host, key, d, version);
          cwd = located.cwd; const commit = located.commit;
          const harnessVersion = d.versions.find((v: Data) => v.id === round.version && v.commit) || version;
          const harnessRes = harnessVersion && harnessVersion.id !== version.id
            ? await versionDirectory(host, key, d, harnessVersion)
            : { cwd, commit };
          const harnessDir = harnessRes.cwd;
          env.commit = commit;
          env.harness = { version: harnessVersion.id, commit: harnessRes.commit || null };
          env.hw = `${env.hardware.os} / ${env.hardware.arch} / ${env.hardware.chip}`;
          await retain(host.storage, key, (state) => {
            const current = state.experiments[d.objective.id];
            if (!current) return;
            if (version.commit) current.versions.find((v: Data) => v.id === version.id).worktree = cwd;
            if (harnessVersion?.commit && harnessVersion.id !== version.id) current.versions.find((v: Data) => v.id === harnessVersion.id).worktree = harnessDir;
            Object.assign(current.rounds.find((r: Data) => r.n === round.n).runs.find((r: Data) => r.id === run.id), { cwd, env });
          });
          // An attempt starts in an empty run directory; an earlier attempt's files are kept beside it. A persisted async job keeps writing into its own.
          if (!jobId && await exists(directory)) {
            let k = 1;
            while (await exists(`${directory}.attempt-${k}`)) k++;
            await rename(directory, `${directory}.attempt-${k}`);
            log += `上一次尝试的文件保留在 ${directory}.attempt-${k}\n`;
          }
          await mkdir(directory, { recursive: true });
          const base = typeof version.config === 'string' ? JSON.parse(await readFile(resolve(cwd, version.config), 'utf8')) : version.config;
          if (!record(base)) throw new Error('Version config must be a JSON object');
          const cycleVars = record(round.plan.cycleVars) ? round.plan.cycleVars : {};
          const merged: Data = { ...base, ...version.vars, ...group.vars, ...cycleVars, seed: run.seed };
          if (round.plan.tier) merged.tier = round.plan.tier;
          else delete merged.tier;
          if ((round.plan.tierRule?.adoption === false || round.plan.tier === 'explore') && Array.isArray(round.plan.reservedSeeds) && round.plan.reservedSeeds.length) merged.reservedSeeds = round.plan.reservedSeeds;
          else delete merged.reservedSeeds;
          if (round.plan.groups.length > 1 && (round.plan.order === 'balanced' || round.plan.order === 'interleaved')) {
            merged.pairedPlan = round.runs.map((r: Data) => ({ group: r.group, seed: r.seed }));
          } else {
            delete merged.pairedPlan;
          }
          const config = JSON.stringify(merged, null, 2) + '\n';
          env.config = env.configHash = createHash('sha256').update(config).digest('hex');
          await writeFile(configFile, config);
          values = { config: configFile, run: directory, seed: run.seed, job: jobId || '', start: Math.floor(start / 1000), harness: harnessDir, version: version.id, commit: commit || '' };
          where = { cwd, values };
          await retain(host.storage, key, (state) => {
            const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
            if (entry) {
              entry.execution = { cwd, values, cancel: executor.commands.cancel, submitted };
            }
          });
        }
        const since = jobId ? start : Date.now();
        if (!jobId) {
          // Before submitting a new job, ensure no earlier failed run still holds an unconfirmed remote jobId.
          const orphans = d.rounds.flatMap((r: Data) => (r.runs || []).filter((u: Data) => u.id !== run.id && ['failed', 'cancelled'].includes(u.state) && !u.retryable && u.jobId).map((u: Data) => ({ cycle: r.n, run: u })));
          for (const orphan of orphans) {
            step = 'orphan-check';
            const oldJob = String(orphan.run.jobId);
            const oldExecution = orphan.run.execution;
            if (!oldExecution) throw new EvidenceBlocked(`Original cleanup context unavailable for ${orphan.run.id}; confirm remote cleanup before rescreening`);
            const oldCwd = oldExecution.cwd, oldValues = { ...oldExecution.values, job: oldJob };
            let oldGet: string | undefined;
            if (oldExecution.context) {
              const bytes = await readFile(oldExecution.context.path, 'utf8').catch(() => '');
              if (fingerprint(bytes) !== oldExecution.context.hash) throw new EvidenceBlocked(`Original cleanup context changed for ${orphan.run.id}`);
              oldGet = JSON.parse(bytes).executor.commands.get;
            }
            const oldCancel = oldExecution.cancel;
            let cleared = false;
            if (oldGet) {
              const probe = await launch(oldGet, oldCwd, oldValues);
              log = (log + probe.log).slice(-16000);
              if (stopped) return;
              if (probe.code === 0) {
                try {
                  const st = parseResult(probe.stdout);
                  if (record(st) && typeof st.state === 'string' && !['queued', 'running'].includes(st.state)) cleared = true;
                } catch {}
              }
            }
            if (!cleared && canCancel(oldCancel, oldValues)) {
              const res = await launch(oldCancel, oldCwd, oldValues);
              log = (log + res.log).slice(-16000);
              if (stopped) return;
              if (res.code === 0) cleared = true;
            }
            if (cleared) {
              await retain(host.storage, key, (state) => {
                const target = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === orphan.cycle)?.runs.find((u: Data) => u.id === orphan.run.id);
                if (target) delete target.jobId;
              });
            } else {
              throw new EvidenceBlocked(`前序失败运行 ${orphan.run.id} 的远端作业 ${oldJob} 仍未确认结束或取消，暂停提交新作业`);
            }
          }
          step = 'preflight';
          const preflight = await launch(executor.commands.preflight, cwd, values);
          log += preflight.log;
          if (preflight.code !== 0) throw new Error(`preflight exited ${preflight.code}: ${preflight.log}`);
          if (preflight.stdout.trim().startsWith('{')) {
            try {
              const reported = parseResult(preflight.stdout);
              if (record(reported)) {
                for (const name of ['python', 'driver', 'dataVersion']) if (reported[name] !== undefined) env[name === 'dataVersion' ? 'data' : name] = reported[name];
              }
            } catch {
              // Optional env metadata: multi-line / NDJSON diagnostic stdout must not fail an exit-0 preflight.
            }
          }
          const submittedConfig = await readFile(configFile, 'utf8');
          env.config = env.configHash = createHash('sha256').update(submittedConfig).digest('hex');
          context = { cwd, values: { ...values }, executor, limit, tracked: !!d.policy.tiers,
            usesHarness: Object.values(executor.commands).some((command) => typeof command === 'string' && command.includes('{harness}')),
            configHash: fingerprint(submittedConfig),
            revision: d.policy.tiers ? await projectRevision(cwd) : null,
            harnessRevision: d.policy.tiers && Object.values(executor.commands).some((command) => typeof command === 'string' && command.includes('{harness}'))
              ? await projectRevision(values.harness) : null };
          const parameters = round.plan.tierRule && d.policy.tiers
            ? executionParameters(version, group, round.plan, JSON.parse(submittedConfig), context.revision, fingerprint({ harness: context.harnessRevision, commands: executor.commands, resultMap: executor.resultMap, failureField: executor.failureField })) : undefined;
          if (parameters && !group.control && group.id !== 'control') {
            const rule = round.plan.tierRule, plan = { ...round.plan, groups: [group] }, actual = [{ group: group.id, parameters }];
            if (rule.promoteFrom && tierEvidence(d, plan, rule.promoteFrom, rule.promotion, actual).length < (rule.promotion?.minCycles || 1)) {
              throw new EvidenceBlocked('Actual execution config or checkout differs from qualifying lower-tier evidence; submit was not started');
            }
            if (group.confirm && d.candidate && !tierEvidence(d, plan, rule.id, undefined, actual).includes(d.candidate.cycle)) {
              throw new EvidenceBlocked('Actual execution config or checkout differs from the selected candidate; submit was not started');
            }
          }
          const contextPath = join(directory, 'execution.json'), contextBytes = JSON.stringify(context);
          await writeFile(contextPath, contextBytes);
          await retain(host.storage, key, (state) => {
            const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
            if (entry) {
              entry.execution.context = { path: contextPath, hash: fingerprint(contextBytes) };
              if (parameters) entry.parameters = parameters;
            }
          });
          step = 'submit';
          if (aborting) throw new Error('Cycle aborted');
          submitted = true;
          await retain(host.storage, key, (state) => {
            const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
            if (entry?.execution) entry.execution.submitted = true;
          });
          if (canCancel(executor.commands.cancel, values)) remote = { key, objective: d.objective.id, cycle: round.n, run: run.id, cancel: executor.commands.cancel, cwd, values };
          awaitingJobId = !!executor.commands.get;
          asyncSubmitBounded = limit > 0;
          let result;
          try { result = await launch(executor.commands.submit, cwd, values, limit); }
          finally { awaitingJobId = false; clearTimeout(abortSubmitTimer); abortSubmitTimer = undefined; }
          log += result.log;
          if (result.timedOut) timedOut = true;
          if (stopped) return;
          if (!executor.commands.get) remote = undefined;
          if (result.code !== 0) {
            if (isNonRetryableOutput(result.stdout) || isNonRetryableOutput(result.log)) kind = 'real';
            throw new Error(`submit exited ${result.code}: ${result.log}`);
          }
          if (executor.commands.get) {
            const output = result.stdout.trim();
            jobId = output.startsWith('{') ? parseResult(output).jobId : output;
            if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Async submit must return a jobId');
            values.job = jobId;
            await retain(host.storage, key, (state) => { const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n).runs.find((r: Data) => r.id === run.id); if (entry) { entry.jobId = jobId; entry.env = env; } });
          }
        }
        if (executor.commands.get) {
          remote = { key, objective: d.objective.id, cycle: round.n, run: run.id, cancel: executor.commands.cancel, cwd, values };
          step = 'get';
          let pollFails = 0, pollFailSince = 0;
          const MAX_POLL_FAILS = 3;
          const pollGraceMs = pollGraceWindowMs(executor.timeout);
          for (;;) {
            if (stopped) return;
            if (aborting) throw new Error('Cycle aborted');
            if (held) throw new Error('Run window closed');
            if (remote?.dropped) throw new Error('Objective deleted');
            const polled = await launch(executor.commands.get, cwd, values);
            log = (log + polled.log).slice(-16000);
            if (stopped) return;
            if (aborting) throw new Error('Cycle aborted');
            if (held) throw new Error('Run window closed');
            if (remote?.dropped) throw new Error('Objective deleted');
            let status: Data | null = null;
            let pollErr = polled.code !== 0 ? `get exited ${polled.code}` : '';
            if (!pollErr) {
              try {
                const parsed = parseResult(polled.stdout);
                if (record(parsed) && typeof parsed.state === 'string') status = parsed;
                else pollErr = 'get returned non-object status without state';
              } catch (e) {
                pollErr = `get returned invalid JSON (${e instanceof Error ? e.message : String(e)})`;
              }
            }
            if (pollErr) {
              pollFails++;
              if (!pollFailSince) pollFailSince = Date.now();
              const pollRetryable = isRetryableOutput(polled.stdout) || isRetryableOutput(polled.log);
              if (pollFails > MAX_POLL_FAILS && (!pollGraceMs || Date.now() - pollFailSince >= pollGraceMs)) { pollLost = true; pollLostRetryable = pollRetryable; throw new Error(`${pollErr} (${pollFails} consecutive poll failures): ${polled.log}`); }
              if (executor.timeout && Date.now() - since > executor.timeout * 1000) { timedOut = true; throw new Error(`异步任务超过 ${executor.timeout} 秒没结束`); }
              await new Promise<void>((done) => { releasePoll = done; pollTimer = setTimeout(done, (executor.poll || 1) * 1000); });
              releasePoll = undefined; pollTimer = undefined;
              continue;
            }
            pollFails = 0; pollFailSince = 0;
            if (status!.state === 'done' && (status!.exitCode === undefined || status!.exitCode === 0)) { remoteEnded = true; break; }
            if (!['queued', 'running'].includes(status!.state)) {
              remoteEnded = true;
              if (status!.retryable === false || status!.errorKind === 'real' || status!.failureKind === 'real') kind = 'real';
              throw new Error(`Remote job ${status!.state}, exit ${status!.exitCode ?? 'unknown'}: ${status!.reason || ''}`);
            }
            if (executor.timeout && Date.now() - since > executor.timeout * 1000) { timedOut = true; throw new Error(`异步任务超过 ${executor.timeout} 秒没结束`); }
            await new Promise<void>((done) => { releasePoll = done; pollTimer = setTimeout(done, (executor.poll || 1) * 1000); });
            releasePoll = undefined; pollTimer = undefined;
          }
          remote = undefined;
        }
        if (stopped) return;
        values.end = Math.floor(Date.now() / 1000);
        step = 'collect';
        await verifyContext();
        const collect = executor.commands.collect as string;
        let raw: string;
        if (/\.json$/.test(collect) && !/\s/.test(collect)) {
          const path = collect.replace(/\{(config|run|seed|job|start|end|harness|version|commit)\}/g, (_, k) => String(values[k] ?? ''));
          raw = await readFile(resolve(cwd, path), 'utf8');
        } else {
          const collected = await launch(collect, cwd, values);
          log = (log + collected.log).slice(-16000);
          if (collected.code !== 0) {
            collectRetryable = isRetryableOutput(collected.stdout) || isRetryableOutput(collected.log);
            throw new Error(`collect exited ${collected.code}: ${collected.log}`);
          }
          raw = collected.stdout;
        }
        kind = 'real';
        const output = parseResult(raw);
        if (!record(output)) throw new Error('Collected metrics must be a JSON object');
        if (output.dataVersion !== undefined) env.data = output.dataVersion;
        const roundScale = roundMetrics(d, round);
        slices = normalizeSlicesInput(output.slices, roundScale.slices);
        const source = record(output.metrics) ? output.metrics : output, invalid: string[] = [];
        for (const metric of roundScale.items) {
          const mapping = executor.resultMap.find((m: Data) => m.metric === metric.id);
          const value = mapping ? field(output, mapping.field) : source[metric.id];
          metrics[metric.id] = value ?? null;
          if (typeof value !== 'number' || !Number.isFinite(value)) invalid.push(metric.id);
        }
        const failure = executor.failureField && field(output, executor.failureField);
        if (failure) error = `Declared failure ${executor.failureField}: ${JSON.stringify(failure)}`;
        else if (invalid.length) error = `Non-finite or missing metrics: ${invalid.join(', ')}`;
      } catch (failure) {
        if (failure instanceof EvidenceBlocked) kind = 'evidence';
        error = failure instanceof Error ? failure.message : String(failure);
      }
      remote = undefined;
      if (stopped) return;
      if (aborting) continue;
      const collectOnlyRetry = step === 'collect' && remoteEnded && collectRetryable;
      const maxRetries = collectOnlyRetry ? 3 : 1;
      const final = error && kind === 'env' && run.retries >= maxRetries, cancel = run.jobId ? run.execution?.cancel : executor.commands.cancel;
      // Held at its window's end, the run waits in the queue for the next night as if it had not started; a job that is not cancelled is polled again.
      if (held && error && kind === 'env') {
        const cancelled = canCancel(cancel, where?.values) && (await command(cancel!, where!.cwd, where!.values)).code === 0;
        await retain(host.storage, key, (state) => {
          const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
          if (entry?.state !== 'running') return;
          Object.assign(entry, { state: 'queued', end: Date.now() });
          if (cancelled) delete entry.jobId;
        });
        continue;
      }
      // A run that fails for good (after its retry) is analysed for its error signature by the executor's analyze command, when registered.
      let analysis: string | undefined;
      if (final && executor.commands.analyze && where) {
        where.values.end ??= Math.floor(Date.now() / 1000);
        const analysed = await launch(executor.commands.analyze, where.cwd, where.values);
        analysis = clip((analysed.stdout.trim() || analysed.log).trim());
      }
      // A job past its timeout, failing for good, or retrying after a foreground submit failure is cancelled so that nothing is left behind remotely.
      // Never cancel when failure occurred before submit (prepare/preflight), and never let cancel output evict the failing step's log.
      const failureLog = log;
      let cancelLog = '', cancelOk = false;
      if (submitted && (timedOut || final || kind === 'evidence' || (pollLost && !pollLostRetryable) || (error && kind === 'env' && step === 'submit')) && canCancel(cancel, where?.values)) {
        const cancelled = await launch(cancel!, where!.cwd, where!.values);
        cancelOk = cancelled.code === 0;
        cancelLog = cancelled.log;
        if (cancelLog) log = `${log}\n[cancel]\n${cancelLog}`.slice(-16000);
      }
      // Retain jobId whenever an async remote job was neither confirmed terminated nor confirmed cancelled, or when collect hit a retryable transport error before final failure.
      const keepJob = !!(jobId && ((!remoteEnded && !cancelOk) || (step === 'collect' && !final && collectRetryable)));
      // A deleted objective's run is neither logged nor recorded: its folder is being removed.
      if (stopped || dropped.has(d.objective.id)) return;
      // The full log stays with the run; the state keeps its tail. The run's result is recorded whether or not the file can be written.
      if (await exists(directory)) await writeFile(join(directory, 'rsi.log'), log).catch((failure) => host.log('error', 'RSI could not write the full run log', { run: run.id, error: String(failure) }));
      const keptLog = cancelLog
        ? `${failureLog.slice(-(LOG_KEEP - 400))}\n[cancel]\n${cancelLog.slice(-360)}`.slice(-LOG_KEEP)
        : failureLog.slice(-LOG_KEEP);
      let retrying = false;
      await retain(host.storage, key, (state) => {
        const current = state.experiments[d.objective.id];
        if (!current) return;
        const cycle = current.rounds.find((r: Data) => r.n === round.n), entry = cycle.runs.find((r: Data) => r.id === run.id);
        if (entry.state !== 'running') return;
        const unconfirmed = keepJob && !remoteEnded ? `远端作业 ${jobId} 未确认结束或取消，可能仍在运行` : '';
        const end = Date.now(), failure = error ? { kind, step, raw: clip(unconfirmed ? `${unconfirmed}；${error}` : error), ...(analysis ? { analysis } : {}) } : null;
        Object.assign(entry, { end, metrics, ...(slices ? { slices } : {}), env, log: keptLog, error: failure, evidence: !error || kind === 'real' });
        entry.attempts ||= [];
        entry.attempts.push({ start, end, env, metrics, ...(slices ? { slices } : {}), error: failure, jobId: jobId || null });
        if (!keepJob) delete entry.jobId;
        if (error && kind === 'env' && entry.retries < maxRetries) {
          retrying = true;
          entry.retries++; entry.state = 'queued';
          cycle.events.push({ at: end, kind: 'retry', text: keepJob ? (remoteEnded ? `${entry.id} 远端作业 ${jobId} 采集遇瞬时传输错误，保留原作业重试采集（第 ${entry.retries}/${maxRetries} 次）` : `${entry.id} 远端作业 ${jobId} 未确认结束或取消，保留原作业继续轮询`) : `${entry.id} 环境失败，自动重试一次；不计入结果` });
        } else {
          entry.state = error && kind !== 'real' ? 'failed' : 'done';
          entry.retryable = false;
          if (error && kind === 'env') message(state, current, end, entry.retries > 1 ? `运行失败（已重试 ${entry.retries} 次）` : '运行失败（已重试一次）', `${entry.id}${unconfirmed ? `\n${unconfirmed}` : ''}\n${clip(error)}`, 'failed');
        }
        if (kind === 'evidence' && error) {
          for (const pending of cycle.runs.filter((r: Data) => r.state === 'queued')) Object.assign(pending, { state: 'cancelled', retryable: false, evidence: false, end });
        }
        finishCycle(state, current, cycle, end);
      });
      await changed(key);
      // Give transient network/SSH hiccups a bounded recovery window before retrying long-running remote jobs.
      if (retrying && !stopped && !held && !aborting && !dropped.has(d.objective.id) && executor.timeout && executor.timeout >= 60) {
        const backoffMs = collectOnlyRetry ? Math.min(60_000, 15_000 * (run.retries + 1)) : 15_000;
        await new Promise<void>((done) => { releasePoll = done; pollTimer = setTimeout(done, backoffMs); });
        releasePoll = undefined; pollTimer = undefined;
      }
    }
  }
  function killChild(proc: ChildProcess | undefined) {
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    try { killTree(proc.pid); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // On macOS/POSIX, signalling a process group whose leader just exited and has not yet been reaped returns EPERM (ESRCH after reaping).
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
  return {
    async interruptAborts(key: string) {
      if (!busy || !runId || aborting) return;
      const stored = await readState(host.storage, key, { readonly: true });
      if (!isState(stored?.value)) return;
      if (!stored.value.experiments[busy]?.rounds.some((r: Data) => r.state === 'aborting' && r.runs.some((u: Data) => u.id === runId))) return;
      aborting = true;
      clearTimeout(pollTimer); releasePoll?.();
      if (!awaitingJobId) killChild(child);
      else if (!asyncSubmitBounded) {
        // Preserve the submit's own timeout while waiting for its acknowledgement.
        // Legacy first submits may have no timeout; give those a finite abort grace.
        const submitting = child;
        abortSubmitTimer = setTimeout(() => killChild(submitting), 30_000);
      }
    },
    // Deleting objectives: an async job is cancelled, a running command is killed, and no further command starts for them.
    async drop(ids: string[]) {
      const job = remote && ids.includes(remote.objective) ? remote : undefined;
      if (job) { job.dropped = true; clearTimeout(pollTimer); releasePoll?.(); }
      if (job?.cancel) {
        const cancelled = await command(job.cancel, job.cwd, job.values);
        if (cancelled.code !== 0) host.log('error', 'RSI remote cancellation failed for a deleted objective', { jobId: job.values.job, error: cancelled.log });
      }
      for (const id of ids) dropped.add(id);
      if (busy && ids.includes(busy)) {
        clearTimeout(pollTimer); releasePoll?.();
        killChild(child);
      }
    },
    // The window of the cycle the schedule started closed: its running run is stopped and waits, like its queued ones, for the window to open again.
    hold(ids: string[]) {
      if (held || !runId || !ids.includes(runId)) return;
      held = true;
      clearTimeout(pollTimer); releasePoll?.();
      killChild(child);
    },
    wake() {
      if (stopped) return;
      if (job) { again = true; return; }
      again = false;
      job = work().catch((error: unknown) => host.log('error', 'RSI execution failed', { error: String(error) })).finally(() => { job = undefined; if (again && !stopped) this.wake(); });
    },
    async stop() {
      stopped = true;
      clearTimeout(pollTimer); releasePoll?.();
      killChild(child);
      await job;
      if (remote?.cancel) {
        const active = remote;
        const cancelled = await command(active.cancel, active.cwd, active.values);
        if (cancelled.code !== 0) { host.log('error', 'RSI remote cancellation failed; job retained', { jobId: active.values.job, error: cancelled.log }); return; }
        await retain(host.storage, active.key, (state) => {
          const cycle = state.experiments[active.objective]?.rounds.find((r: Data) => r.n === active.cycle);
          if (!cycle) return;
          const run = cycle.runs.find((r: Data) => r.id === active.run);
          delete run.jobId;
          if (cycle.aborted) { run.cancelResult = { status: 'cancelled', code: 0, log: cancelled.log.slice(-LOG_KEEP), at: Date.now() }; return; }
          cycle.state = 'interrupted';
          Object.assign(run, { state: 'failed', retryable: true, end: Date.now(), error: { kind: 'env', step: 'cancel', raw: '插件停止，已调用 cancel；可重试。' } });
        });
      }
    },
  };
}
