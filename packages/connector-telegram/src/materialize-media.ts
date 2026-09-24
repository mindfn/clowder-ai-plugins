import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface MaterializedMedia {
  readonly path: string;
  cleanup(): Promise<void>;
}

/** Materialize a Host-authorized byte stream inside a package-owned private directory. */
export async function materializeMedia(
  content: AsyncIterable<Uint8Array>,
  fileName = 'media.bin',
): Promise<MaterializedMedia> {
  const directory = await mkdtemp(join(tmpdir(), 'clowder-telegram-outbound-'));
  const candidate = basename(fileName).trim();
  const safeName = candidate.length === 0 || candidate === '.' || candidate === '..' ? 'media.bin' : candidate;
  const path = join(directory, safeName);
  try {
    await pipeline(Readable.from(content), createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
