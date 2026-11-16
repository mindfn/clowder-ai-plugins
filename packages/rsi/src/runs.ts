import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { finishCycle } from './cycles.js';
import { message, recordInitExecution, submitInitStep } from './init.js';
import { isState, record, retain } from './store.js';
import { projectCommit, removeVersionWorktrees, versionDirectory } from './versions.js';
import type { Data, RsiHost } from './types.js';

const quote = (value: string | number) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const render = (command: string, values: Data) => command.replace(/\{(config|run|seed|job)\}/g, (_, k) => quote(values[k]));
const field = (value: Data, path: string) => path.split('.').reduce((v: any, k) => v?.[k], value);
const parseResult = (raw: string) => JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|\bNaN\b|-?Infinity\b/g, (token) => token.startsWith('"') ? token : JSON.stringify(token)));

export function createRuns(host: RsiHost, changed: (key: string) => Promise<void>) {
  let stopped = false, again = false, child: ChildProcess | undefined, job: Promise<void> | undefined, remote: Data | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, releasePoll: (() => void) | undefined;
  async function command(template: string, cwd: string, values: Data) {
    let log = '', stdout = '';
    const process = child = spawn('/bin/sh', ['-c', render(template, values)], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout!.on('data', (part) => { stdout = (stdout + part).slice(-16000); log = (log + part).slice(-16000); });
    process.stderr!.on('data', (part) => { log = (log + part).slice(-16000); });
    const code = await new Promise<number>((done) => {
      process.once('error', (error) => { log += error.message; done(-1); });
      process.once('close', (exit, signal) => { if (signal) log += `\n${signal}`; done(exit ?? -1); });
    });
    if (child === process) child = undefined;
    return { code, log, stdout };
  }

  async function work() {
    while (!stopped) {
      const entries = await host.storage.list();
      const owners = Object.entries(entries).filter(([key, entry]) => key.startsWith('rsi:') && isState(entry.value));
      const retired = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && ['done', 'retired'].includes(d.objective.state) && d.versions.some((v: Data) => v.worktree)).map((d) => ({ key, d })))[0];
      if (retired) {
        await removeVersionWorktrees(retired.d);
        await retain(host.storage, retired.key, (state) => { for (const v of state.experiments[retired.d.objective.id].versions) delete v.worktree; });
        continue;
      }
      const probe = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && d.executor.state === 'probing' && d.exec?.run?.state === 'started')
        .map((d) => ({ key, d })))[0];
      if (probe) {
        const { key, d } = probe, executionId = d.exec!.run!.id;
        const result = await command(d.executor.commands.preflight, d.objective.projectPath, { config: '', run: '', seed: 0, job: '' });
        const commit = await projectCommit(d.objective.projectPath);
        if (stopped) return;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (current.exec?.run?.id !== executionId || current.executor.state !== 'probing') return;
          current.executor.state = result.code === 0 ? 'passed' : 'failed';
          current.executor.probe = { at: Date.now(), error: result.code === 0 ? null : result.log || `exit ${result.code}`, log: result.log };
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
        .flatMap((d) => d.rounds.filter((r: Data) => r.state === 'running').flatMap((round: Data) => round.runs.filter((run: Data) => run.state === 'queued').map((run: Data) => ({ key, d, round, run })))))[0];
      if (!queued) return;
      const { key, d, round, run } = queued;
      const group = round.plan.groups.find((g: Data) => g.id === run.group), version = d.versions.find((v: Data) => v.id === group.version);
      const directory = join(d.objective.projectPath, 'runs', d.objective.id, String(round.n), `${group.id}-s${run.seed}`);
      const configFile = join(directory, 'config.json'), start = Date.now();
      let acquired = false;
      await retain(host.storage, key, (state) => {
        acquired = false;
        const objective = state.experiments[d.objective.id], current = objective.rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
        if (objective.objective.state !== 'running' || current?.state !== 'queued') return;
        acquired = true;
        Object.assign(current, { state: 'running', start, end: null, directory });
      });
      if (!acquired || stopped) continue;
      let metrics: Data = {}, env: Data = { seed: run.seed, hardware: { os: `${platform()} ${release()}`, arch: arch(), chip: cpus()[0]?.model || 'unknown' } };
      let log = '', error: string | undefined, kind = 'env', step = 'prepare', jobId = run.jobId;
      try {
        const { cwd, commit } = await versionDirectory(host, key, d, version);
        env.commit = commit;
        env.hw = `${env.hardware.os} / ${env.hardware.arch} / ${env.hardware.chip}`;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (version.commit) current.versions.find((v: Data) => v.id === version.id).worktree = cwd;
          Object.assign(current.rounds.find((r: Data) => r.n === round.n).runs.find((r: Data) => r.id === run.id), { cwd, env });
        });
        await mkdir(directory, { recursive: true });
        const base = typeof version.config === 'string' ? JSON.parse(await readFile(resolve(cwd, version.config), 'utf8')) : version.config;
        if (!record(base)) throw new Error('Version config must be a JSON object');
        const config = JSON.stringify({ ...base, ...version.vars, ...group.vars, seed: run.seed }, null, 2) + '\n';
        env.config = env.configHash = createHash('sha256').update(config).digest('hex');
        await writeFile(configFile, config);
        const values: Data = { config: configFile, run: directory, seed: run.seed, job: jobId || '' };
        step = 'preflight';
        const preflight = await command(d.executor.commands.preflight, cwd, values);
        log += preflight.log;
        if (preflight.code !== 0) throw new Error(`preflight exited ${preflight.code}: ${preflight.log}`);
        if (preflight.stdout.trim().startsWith('{')) {
          const reported = parseResult(preflight.stdout);
          for (const name of ['python', 'driver', 'dataVersion']) if (reported[name] !== undefined) env[name === 'dataVersion' ? 'data' : name] = reported[name];
        }
        if (!jobId) {
          step = 'submit';
          const result = await command(d.executor.commands.submit, cwd, values);
          log += result.log;
          if (result.code !== 0) throw new Error(`submit exited ${result.code}: ${result.log}`);
          if (stopped) return;
          if (d.executor.commands.get) {
            const output = result.stdout.trim();
            jobId = output.startsWith('{') ? parseResult(output).jobId : output;
            if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Async submit must return a jobId');
            values.job = jobId;
            await retain(host.storage, key, (state) => { state.experiments[d.objective.id].rounds.find((r: Data) => r.n === round.n).runs.find((r: Data) => r.id === run.id).jobId = jobId; });
          }
        }
        if (d.executor.commands.get) {
          remote = { key, objective: d.objective.id, cycle: round.n, run: run.id, cancel: d.executor.commands.cancel, cwd, values };
          step = 'get';
          for (;;) {
            if (stopped) return;
            const polled = await command(d.executor.commands.get, cwd, values);
            log = (log + polled.log).slice(-16000);
            if (stopped) return;
            if (polled.code !== 0) throw new Error(`get exited ${polled.code}: ${polled.log}`);
            const status = parseResult(polled.stdout);
            if (status.state === 'done' && (status.exitCode === undefined || status.exitCode === 0)) break;
            if (!['queued', 'running'].includes(status.state)) throw new Error(`Remote job ${status.state}, exit ${status.exitCode ?? 'unknown'}: ${status.reason || ''}`);
            await new Promise<void>((done) => { releasePoll = done; pollTimer = setTimeout(done, 1000); });
            releasePoll = undefined; pollTimer = undefined;
          }
          remote = undefined;
        }
        if (stopped) return;
        step = 'collect';
        const collect = d.executor.commands.collect as string;
        let raw: string;
        if (/\.json$/.test(collect) && !/\s/.test(collect)) {
          const path = collect.replace(/\{(config|run|seed|job)\}/g, (_, k) => String(values[k]));
          raw = await readFile(resolve(cwd, path), 'utf8');
        } else {
          const collected = await command(collect, cwd, values);
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
      await retain(host.storage, key, (state) => {
        const current = state.experiments[d.objective.id], cycle = current.rounds.find((r: Data) => r.n === round.n), entry = cycle.runs.find((r: Data) => r.id === run.id);
        if (entry.state !== 'running') return;
        const end = Date.now(), failure = error ? { kind, step, raw: error } : null;
        Object.assign(entry, { end, metrics, env, log, error: failure, evidence: !error || kind === 'real' });
        entry.attempts ||= [];
        entry.attempts.push({ start, end, env, metrics, error: failure, jobId: jobId || null });
        delete entry.jobId;
        if (error && kind === 'env' && entry.retries < 1) {
          entry.retries++; entry.state = 'queued';
          cycle.events.push({ at: end, kind: 'retry', text: `${entry.id} 环境失败，自动重试一次；不计入结果` });
        } else {
          entry.state = error && kind === 'env' ? 'failed' : 'done';
          entry.retryable = false;
          if (error && kind === 'env') message(state, current, end, '运行失败（已重试一次）', `${entry.id}\n${error}`, 'failed');
        }
        finishCycle(state, current, cycle, end);
      });
      await changed(key);
    }
  }
  return {
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
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await job;
      if (remote?.cancel) {
        const active = remote;
        const cancelled = await command(active.cancel, active.cwd, active.values);
        if (cancelled.code !== 0) { host.log('error', 'RSI remote cancellation failed; job retained', { jobId: active.values.job, error: cancelled.log }); return; }
        await retain(host.storage, active.key, (state) => {
          const cycle = state.experiments[active.objective].rounds.find((r: Data) => r.n === active.cycle), run = cycle.runs.find((r: Data) => r.id === active.run);
          delete run.jobId;
          cycle.state = 'interrupted';
          Object.assign(run, { state: 'failed', retryable: true, end: Date.now(), error: { kind: 'env', step: 'cancel', raw: '插件停止，已调用 cancel；可重试。' } });
        });
      }
    },
  };
}
