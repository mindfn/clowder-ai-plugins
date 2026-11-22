import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { finishCycle } from './cycles.js';
import { message, recordInitExecution, submitInitStep } from './init.js';
import { insideWindow } from './schedule.js';
import { clip, listOwners, LOG_KEEP, record, retain } from './store.js';
import { projectCommit, removeVersionWorktrees, versionDirectory } from './versions.js';
import type { Data, RsiHost } from './types.js';

// A registered command runs in the host system's shell, like any spawned command: sh, or cmd on Windows. What it does is the members' business.
const windows = platform() === 'win32';
export const quote = (value: string | number, win = windows) => win ? `"${String(value).replace(/"/g, '""')}"` : `'${String(value).replace(/'/g, `'"'"'`)}'`;
// A stopped command takes what it started with it: its process group, or its process tree on Windows.
function killTree(pid: number) {
  if (windows) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else process.kill(-pid, 'SIGKILL');
}
const render = (command: string, values: Data) => command.replace(/\{(config|run|seed|job|start|end)\}/g, (_, k) => quote(values[k]));
const canCancel = (tpl: string | undefined, values: Data | undefined) => !!tpl && !!values && (!!values.job || !tpl.includes('{job}'));
const field = (value: Data, path: string) => path.split('.').reduce((v: any, k) => v?.[k], value);
const exists = (path: string) => stat(path).then(() => true, () => false);
const parseResult = (raw: string) => JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|\bNaN\b|-?Infinity\b/g, (token) => token.startsWith('"') ? token : JSON.stringify(token)));

export function createRuns(host: RsiHost, changed: (key: string) => Promise<void>) {
  let stopped = false, again = false, held = false, child: ChildProcess | undefined, job: Promise<void> | undefined, remote: Data | undefined;
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
      try { killTree(process.pid!); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') host.log('error', 'RSI could not stop a timed-out command', { error: String(error) }); }
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
  const launch = (template: string, cwd: string, values: Data, limit = 0) => stopped || held ? Promise.resolve({ code: -1, log: held ? 'Run window closed' : 'Plugin stopped', stdout: '', timedOut: false }) : command(template, cwd, values, limit);

  async function work() {
    while (!stopped) {
      busy = runId = undefined; held = false;
      const owners = await listOwners(host.storage);
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
        const result = await launch(d.executor.commands.preflight, probeCwd, { config: '', run: '', seed: 0, job: '' });
        const commit = await projectCommit(d.objective.projectPath);
        if (stopped) return;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (current?.exec?.run?.id !== executionId || current.executor.state !== 'probing') return;
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
      const group = round.plan.groups.find((g: Data) => g.id === run.group), version = d.versions.find((v: Data) => v.id === group.version);
      const directory = join(d.objective.projectPath, 'runs', d.objective.id, String(round.n), `${group.id}-s${run.seed}`);
      // A persisted async job keeps the start of the attempt that submitted it: its {start} and timeout count from there.
      const configFile = join(directory, 'config.json'), start = run.jobId ? run.start : Date.now();
      let acquired = false;
      await retain(host.storage, key, (state) => {
        acquired = false;
        const objective = state.experiments[d.objective.id], current = objective?.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
        if (objective?.objective.state !== 'running' || current?.state !== 'queued') return;
        acquired = true;
        Object.assign(current, { state: 'running', start, end: null, directory });
      });
      if (!acquired || stopped) continue;
      busy = d.objective.id; runId = run.id;
      let metrics: Data = {}, env: Data = { seed: run.seed, hardware: { os: `${platform()} ${release()}`, arch: arch(), chip: cpus()[0]?.model || 'unknown' } };
      let log = '', error: string | undefined, kind = 'env', step = 'prepare', jobId = run.jobId, timedOut = false, submitted = !!jobId;
      // The foreground submit's limit: the registered timeout, else three times this objective's longest successful attempt (at least 10 minutes); none before one has succeeded.
      const succeeded = d.rounds.flatMap((r: Data) => r.runs.flatMap((x: Data) => (x.attempts || []).filter((a: Data) => !a.error).map((a: Data) => a.end - a.start)));
      const limit = d.executor.timeout ? d.executor.timeout * 1000 : succeeded.length ? Math.max(600_000, 3 * Math.max(...succeeded)) : 0;
      let where: { cwd: string; values: Data } | undefined;
      try {
        const { cwd, commit } = await versionDirectory(host, key, d, version);
        env.commit = commit;
        env.hw = `${env.hardware.os} / ${env.hardware.arch} / ${env.hardware.chip}`;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (!current) return;
          if (version.commit) current.versions.find((v: Data) => v.id === version.id).worktree = cwd;
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
        const config = JSON.stringify({ ...(round.plan.tier ? { tier: round.plan.tier } : {}), ...base, ...version.vars, ...group.vars, seed: run.seed }, null, 2) + '\n';
        env.config = env.configHash = createHash('sha256').update(config).digest('hex');
        await writeFile(configFile, config);
        const values: Data = { config: configFile, run: directory, seed: run.seed, job: jobId || '', start: Math.floor(start / 1000) };
        where = { cwd, values };
        step = 'preflight';
        const preflight = await launch(d.executor.commands.preflight, cwd, values);
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
        const since = jobId ? start : Date.now();
        if (!jobId) {
          step = 'submit';
          submitted = true;
          if (canCancel(d.executor.commands.cancel, values)) remote = { key, objective: d.objective.id, cycle: round.n, run: run.id, cancel: d.executor.commands.cancel, cwd, values };
          const result = await launch(d.executor.commands.submit, cwd, values, limit);
          log += result.log;
          if (result.timedOut) timedOut = true;
          if (stopped) return;
          if (!d.executor.commands.get) remote = undefined;
          if (result.code !== 0) throw new Error(`submit exited ${result.code}: ${result.log}`);
          if (d.executor.commands.get) {
            const output = result.stdout.trim();
            jobId = output.startsWith('{') ? parseResult(output).jobId : output;
            if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Async submit must return a jobId');
            values.job = jobId;
            await retain(host.storage, key, (state) => { const entry = state.experiments[d.objective.id]?.rounds.find((r: Data) => r.n === round.n).runs.find((r: Data) => r.id === run.id); if (entry) entry.jobId = jobId; });
          }
        }
        if (d.executor.commands.get) {
          remote = { key, objective: d.objective.id, cycle: round.n, run: run.id, cancel: d.executor.commands.cancel, cwd, values };
          step = 'get';
          for (;;) {
            if (stopped) return;
            if (remote?.dropped) throw new Error('Objective deleted');
            const polled = await launch(d.executor.commands.get, cwd, values);
            log = (log + polled.log).slice(-16000);
            if (stopped) return;
            if (polled.code !== 0) throw new Error(`get exited ${polled.code}: ${polled.log}`);
            const status = parseResult(polled.stdout);
            if (status.state === 'done' && (status.exitCode === undefined || status.exitCode === 0)) break;
            if (!['queued', 'running'].includes(status.state)) throw new Error(`Remote job ${status.state}, exit ${status.exitCode ?? 'unknown'}: ${status.reason || ''}`);
            if (d.executor.timeout && Date.now() - since > d.executor.timeout * 1000) { timedOut = true; throw new Error(`异步任务超过 ${d.executor.timeout} 秒没结束`); }
            await new Promise<void>((done) => { releasePoll = done; pollTimer = setTimeout(done, (d.executor.poll || 1) * 1000); });
            releasePoll = undefined; pollTimer = undefined;
          }
          remote = undefined;
        }
        if (stopped) return;
        values.end = Math.floor(Date.now() / 1000);
        step = 'collect';
        const collect = d.executor.commands.collect as string;
        let raw: string;
        if (/\.json$/.test(collect) && !/\s/.test(collect)) {
          const path = collect.replace(/\{(config|run|seed|job|start|end)\}/g, (_, k) => String(values[k]));
          raw = await readFile(resolve(cwd, path), 'utf8');
        } else {
          const collected = await launch(collect, cwd, values);
          log = (log + collected.log).slice(-16000);
          if (collected.code !== 0) throw new Error(`collect exited ${collected.code}: ${collected.log}`);
          raw = collected.stdout;
        }
        kind = 'real';
        const output = parseResult(raw);
        if (!record(output)) throw new Error('Collected metrics must be a JSON object');
        if (output.dataVersion !== undefined) env.data = output.dataVersion;
        const source = record(output.metrics) ? output.metrics : output, invalid: string[] = [];
        for (const metric of (round.metrics || d.metrics).items) {
          const mapping = d.executor.resultMap.find((m: Data) => m.metric === metric.id);
          const value = mapping ? field(output, mapping.field) : source[metric.id];
          metrics[metric.id] = value ?? null;
          if (typeof value !== 'number' || !Number.isFinite(value)) invalid.push(metric.id);
        }
        const failure = d.executor.failureField && field(output, d.executor.failureField);
        if (failure) error = `Declared failure ${d.executor.failureField}: ${JSON.stringify(failure)}`;
        else if (invalid.length) error = `Non-finite or missing metrics: ${invalid.join(', ')}`;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      remote = undefined;
      if (stopped) return;
      const final = error && kind === 'env' && run.retries >= 1, cancel = d.executor.commands.cancel;
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
      if (final && d.executor.commands.analyze && where) {
        where.values.end ??= Math.floor(Date.now() / 1000);
        const analysed = await launch(d.executor.commands.analyze, where.cwd, where.values);
        analysis = clip((analysed.stdout.trim() || analysed.log).trim());
      }
      // A job past its timeout, failing for good, or retrying after a foreground submit failure is cancelled so that nothing is left behind remotely.
      // Never cancel when failure occurred before submit (prepare/preflight), and never let cancel output evict the failing step's log.
      const failureLog = log;
      let cancelLog = '';
      if (submitted && (timedOut || final || (error && kind === 'env' && step === 'submit')) && canCancel(cancel, where?.values)) {
        cancelLog = (await launch(cancel!, where!.cwd, where!.values)).log;
        if (cancelLog) log = `${log}\n[cancel]\n${cancelLog}`.slice(-16000);
      }
      // A deleted objective's run is neither logged nor recorded: its folder is being removed.
      if (stopped || dropped.has(d.objective.id)) return;
      // The full log stays with the run; the state keeps its tail. The run's result is recorded whether or not the file can be written.
      if (await exists(directory)) await writeFile(join(directory, 'rsi.log'), log).catch((failure) => host.log('error', 'RSI could not write the full run log', { run: run.id, error: String(failure) }));
      const keptLog = cancelLog
        ? `${failureLog.slice(-(LOG_KEEP - 400))}\n[cancel]\n${cancelLog.slice(-360)}`.slice(-LOG_KEEP)
        : failureLog.slice(-LOG_KEEP);
      await retain(host.storage, key, (state) => {
        const current = state.experiments[d.objective.id];
        if (!current) return;
        const cycle = current.rounds.find((r: Data) => r.n === round.n), entry = cycle.runs.find((r: Data) => r.id === run.id);
        if (entry.state !== 'running') return;
        const end = Date.now(), failure = error ? { kind, step, raw: clip(error), ...(analysis ? { analysis } : {}) } : null;
        Object.assign(entry, { end, metrics, env, log: keptLog, error: failure, evidence: !error || kind === 'real' });
        entry.attempts ||= [];
        entry.attempts.push({ start, end, env, metrics, error: failure, jobId: jobId || null });
        delete entry.jobId;
        if (error && kind === 'env' && entry.retries < 1) {
          entry.retries++; entry.state = 'queued';
          cycle.events.push({ at: end, kind: 'retry', text: `${entry.id} 环境失败，自动重试一次；不计入结果` });
        } else {
          entry.state = error && kind === 'env' ? 'failed' : 'done';
          entry.retryable = false;
          if (error && kind === 'env') message(state, current, end, '运行失败（已重试一次）', `${entry.id}\n${clip(error)}`, 'failed');
        }
        finishCycle(state, current, cycle, end);
      });
      await changed(key);
    }
  }
  return {
    // Deleting objectives: an async job is cancelled, a running command is killed, and no further command starts for them.
    async drop(ids: string[]) {
      const job = remote && ids.includes(remote.objective) ? remote : undefined;
      if (job) { job.dropped = true; clearTimeout(pollTimer); releasePoll?.(); }
      if (job?.cancel) {
        const cancelled = await command(job.cancel, job.cwd, job.values);
        if (cancelled.code !== 0) host.log('error', 'RSI remote cancellation failed for a deleted objective', { jobId: job.values.job, error: cancelled.log });
      }
      for (const id of ids) dropped.add(id);
      if (busy && ids.includes(busy) && child?.pid) {
        try { killTree(child.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    },
    // The window of the cycle the schedule started closed: its running run is stopped and waits, like its queued ones, for the window to open again.
    hold(ids: string[]) {
      if (held || !runId || !ids.includes(runId)) return;
      held = true;
      clearTimeout(pollTimer); releasePoll?.();
      if (child?.pid) {
        try { killTree(child.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
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
      if (child?.pid) {
        try { killTree(child.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
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
          cycle.state = 'interrupted';
          Object.assign(run, { state: 'failed', retryable: true, end: Date.now(), error: { kind: 'env', step: 'cancel', raw: '插件停止，已调用 cancel；可重试。' } });
        });
      }
    },
  };
}
