import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { finishCycle } from './cycles.js';
import { message, recordInitExecution, submitInitStep } from './init.js';
import { isState, record, retain } from './store.js';
import type { Data, RsiHost } from './types.js';

const quote = (value: string | number) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const render = (command: string, values: Data) => command.replace(/\{(config|run|seed)\}/g, (_, k) => quote(values[k]));
const field = (value: Data, path: string) => path.split('.').reduce((v: any, k) => v?.[k], value);

export function createRuns(host: RsiHost, changed: (key: string) => Promise<void>) {
  let stopped = false, again = false, child: ChildProcess | undefined, job: Promise<void> | undefined;
  async function command(template: string, cwd: string, values: Data) {
    let log = '';
    const process = child = spawn('/bin/sh', ['-c', render(template, values)], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout!.on('data', (part) => { log = (log + part).slice(-16000); });
    process.stderr!.on('data', (part) => { log = (log + part).slice(-16000); });
    const code = await new Promise<number>((done) => {
      process.once('error', (error) => { log += error.message; done(-1); });
      process.once('close', (exit) => done(exit ?? -1));
    });
    if (child === process) child = undefined;
    return { code, log };
  }

  async function work() {
    while (!stopped) {
      const entries = await host.storage.list();
      const owners = Object.entries(entries).filter(([key, entry]) => key.startsWith('rsi:') && isState(entry.value));
      const probe = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && d.executor.state === 'probing' && d.exec?.run?.state === 'started')
        .map((d) => ({ key, d })))[0];
      if (probe) {
        const { key, d } = probe, executionId = d.exec!.run!.id;
        const result = await command(d.executor.commands.preflight, d.objective.projectPath, { config: '', run: '', seed: 0 });
        if (stopped) return;
        await retain(host.storage, key, (state) => {
          const current = state.experiments[d.objective.id];
          if (current.exec?.run?.id !== executionId || current.executor.state !== 'probing') return;
          current.executor.state = result.code === 0 ? 'passed' : 'failed';
          current.executor.probe = { at: Date.now(), error: result.code === 0 ? null : result.log || `exit ${result.code}`, log: result.log };
          const pending = current.executor.pending;
          delete current.executor.pending;
          if (result.code !== 0) recordInitExecution(state, d.objective.id, 'run', executionId, 'failed', Date.now(), { reason: current.executor.probe.error });
          else if (pending) submitInitStep(state, d.objective.id, { ...pending, executor: current.executor }, Date.now());
        });
        await changed(key);
        continue;
      }
      const queued = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
        .filter((d) => d.objective.projectPath && d.objective.state !== 'paused')
        .flatMap((d) => d.rounds.filter((r: Data) => r.state === 'running').flatMap((round: Data) => round.runs.filter((run: Data) => run.state === 'queued').map((run: Data) => ({ key, d, round, run })))))[0];
      if (!queued) return;
      const { key, d, round, run } = queued;
      const group = round.plan.groups.find((g: Data) => g.id === run.group), version = d.versions.find((v: Data) => v.id === group.version);
      const directory = join(d.objective.projectPath, 'runs', d.objective.id, String(round.n), `${group.id}-s${run.seed}`);
      const configFile = join(directory, 'config.json'), start = Date.now();
      let acquired = false;
      await retain(host.storage, key, (state) => {
        acquired = false;
        const current = state.experiments[d.objective.id].rounds.find((r: Data) => r.n === round.n)?.runs.find((r: Data) => r.id === run.id);
        if (current?.state !== 'queued') return;
        acquired = true;
        Object.assign(current, { state: 'running', start, end: null, directory, env: { commit: version.commit || null, config: configFile, hw: process.arch, driver: process.version, data: '' } });
      });
      if (!acquired || stopped) continue;
      let metrics: Data = {}, log = '', error: string | undefined;
      try {
        await mkdir(directory, { recursive: true });
        const base = typeof version.config === 'string' ? JSON.parse(await readFile(resolve(d.objective.projectPath, version.config), 'utf8')) : version.config || {};
        if (!record(base)) throw new Error('Version config must be a JSON object');
        await writeFile(configFile, JSON.stringify({ ...base, ...group.vars, seed: run.seed }, null, 2) + '\n');
        const values = { config: configFile, run: directory, seed: run.seed };
        const result = await command(d.executor.commands.submit, d.objective.projectPath, values);
        log = result.log;
        if (result.code !== 0) throw new Error(`submit exited ${result.code}: ${log}`);
        if (stopped) return;
        const collect = d.executor.commands.collect as string;
        let raw: string;
        if (/\.json$/.test(collect) && !/\s/.test(collect)) {
          const path = collect.replace(/\{(config|run|seed)\}/g, (_, k) => String(values[k as keyof typeof values]));
          raw = await readFile(resolve(d.objective.projectPath, path), 'utf8');
        } else {
          const collected = await command(collect, d.objective.projectPath, values);
          if (collected.code !== 0) throw new Error(`collect exited ${collected.code}: ${collected.log}`);
          raw = collected.log;
        }
        const output = JSON.parse(raw);
        if (!record(output)) throw new Error('Collected metrics must be a JSON object');
        const source = record(output.metrics) ? output.metrics : output;
        for (const metric of d.metrics.items) {
          const mapping = d.executor.resultMap.find((m: Data) => m.metric === metric.id);
          const value = mapping ? field(output, mapping.field) : source[metric.id];
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Missing finite metric: ${metric.id}`);
          metrics[metric.id] = value;
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      if (stopped) return;
      await retain(host.storage, key, (state) => {
        const current = state.experiments[d.objective.id], cycle = current.rounds.find((r: Data) => r.n === round.n), entry = cycle.runs.find((r: Data) => r.id === run.id);
        if (entry.state !== 'running') return;
        Object.assign(entry, { end: Date.now(), metrics, log, error: error ? { kind: 'real', step: 'submit/collect', raw: error } : null });
        if (error && entry.retries < 1) {
          entry.retries++; entry.state = 'queued';
          cycle.events.push({ at: Date.now(), kind: 'retry', text: `${entry.id} 自动重试一次` });
        } else {
          entry.state = error ? 'failed' : 'done';
          entry.retryable = false;
          if (error) message(state, current, Date.now(), '运行失败（已重试一次）', `${entry.id}\n${error}`, 'failed');
        }
        finishCycle(state, current, cycle, Date.now());
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
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await job;
    },
  };
}
