/**
 * Label-review tool — HTTP server.
 *
 * Serves a UI for humans to walk through cursor-detection training
 * labels and confirm / correct / mark-absent / skip each frame. Human
 * decisions go into a per-dataset jsonl file. The source jsonl is
 * never modified.
 *
 * Datasets are declared via repeatable --dataset flags or via the
 * convenience --repo flag which sets up the two project-standard
 * datasets pointing into the given repo's data/ directory.
 *
 * See `tools/label-review/README.md` for usage.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

type ImageStrategy =
  | { kind: 'dir'; base: string }
  | { kind: 'abs' };

interface DatasetConfig {
  name: string;
  jsonlPath: string;
  verifiedPath: string;
  images: ImageStrategy;
}

interface RawEntry {
  frame?: string;
  abs_frame_path?: string;
  cursor?: { visible: boolean; x?: number | null; y?: number | null };
  algorithm_label?: { x: number; y: number } | null;
  [k: string]: unknown;
}

interface VerifiedEntry {
  frame: string;
  source_dataset: string;
  decision: 'confirm' | 'correct' | 'absent' | 'skip';
  cursor?: { visible: boolean; x?: number; y?: number };
  decided_at: string;
}

interface Claim {
  sessionId: string;
  dataset: string;
  frameId: string;
  lastSeenMs: number;
}

const claims = new Map<string, Claim>();
const CLAIM_TTL_MS = 60_000;

function pruneExpiredClaims(now: number): void {
  const cutoff = now - 2 * CLAIM_TTL_MS;
  for (const [k, c] of claims) {
    if (c.lastSeenMs < cutoff) claims.delete(k);
  }
}

function isClaimedByOther(
  dataset: string,
  frameId: string,
  sessionId: string,
  now: number,
): boolean {
  for (const c of claims.values()) {
    if (c.sessionId === sessionId) continue;
    if (c.dataset !== dataset) continue;
    if (c.frameId !== frameId) continue;
    if (now - c.lastSeenMs >= CLAIM_TTL_MS) continue;
    return true;
  }
  return false;
}

function activeSessionCount(now: number): number {
  let n = 0;
  for (const c of claims.values()) {
    if (now - c.lastSeenMs < CLAIM_TTL_MS) n++;
  }
  return n;
}

function validateSessionId(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  if (s.length < 8 || s.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return s;
}

interface CliArgs {
  port: number;
  host: string;
  datasets: DatasetConfig[];
}

function usage(): string {
  return `Usage: server.ts [options]

  --port <n>         HTTP port (default: 8765)
  --host <addr>      Bind address (default: 127.0.0.1)
  --dataset <spec>   Add a dataset (repeatable). Spec is a comma-separated
                     key=value list. Required keys:
                       name=<id>
                       jsonl=<path-to-source-verified.jsonl>
                       verified=<path-where-decisions-are-appended>
                       images=<strategy>
                     where <strategy> is one of:
                       abs          — image path is entry.abs_frame_path
                       dir:<path>   — image path is <path>/<entry.frame>
  --repo <path>      Convenience: when no --dataset is given, expand to the
                     two project-standard datasets rooted at <path>/data/.

Either --repo or at least one --dataset is required.

Examples:
  server.ts --repo .
  server.ts --port 9000 \\
    --dataset name=v0,jsonl=./data/cursor-training-v0/verified.jsonl,verified=./data/cursor-training-v0/human-verified.jsonl,images=dir:./data/cursor-training-v0 \\
    --dataset name=emit,jsonl=./data/cursor-training-v0-emit/verified.jsonl,verified=./data/cursor-training-v0-emit/human-verified.jsonl,images=abs
`;
}

function parseDatasetSpec(spec: string): DatasetConfig {
  const parts = spec.split(',').filter((p) => p.length > 0);
  const map = new Map<string, string>();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) throw new Error(`dataset spec part missing '=': ${p}`);
    map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
  }
  const need = (k: string): string => {
    const v = map.get(k);
    if (!v) throw new Error(`--dataset missing required key ${k}: ${spec}`);
    return v;
  };
  const name = need('name');
  const jsonlPath = resolve(need('jsonl'));
  const verifiedPath = resolve(need('verified'));
  const imgRaw = need('images');
  let images: ImageStrategy;
  if (imgRaw === 'abs') {
    images = { kind: 'abs' };
  } else if (imgRaw.startsWith('dir:')) {
    images = { kind: 'dir', base: resolve(imgRaw.slice(4)) };
  } else {
    throw new Error(`--dataset images=${imgRaw}: expected "abs" or "dir:<path>"`);
  }
  return { name, jsonlPath, verifiedPath, images };
}

function defaultDatasetsForRepo(repo: string): DatasetConfig[] {
  const repoAbs = resolve(repo);
  return [
    {
      name: 'v0',
      jsonlPath: join(repoAbs, 'data', 'cursor-training-v0', 'verified.jsonl'),
      verifiedPath: join(repoAbs, 'data', 'cursor-training-v0', 'human-verified.jsonl'),
      images: { kind: 'dir', base: join(repoAbs, 'data', 'cursor-training-v0') },
    },
    {
      name: 'emit',
      jsonlPath: join(repoAbs, 'data', 'cursor-training-v0-emit', 'verified.jsonl'),
      verifiedPath: join(repoAbs, 'data', 'cursor-training-v0-emit', 'human-verified.jsonl'),
      images: { kind: 'abs' },
    },
  ];
}

function parseArgs(argv: string[]): CliArgs {
  let port = 8765;
  let host = '127.0.0.1';
  const datasets: DatasetConfig[] = [];
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.error(usage());
      process.exit(0);
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isFinite(port) || port <= 0) throw new Error('--port: invalid number');
    } else if (a === '--host') {
      host = argv[++i];
      if (!host) throw new Error('--host: missing value');
    } else if (a === '--dataset') {
      datasets.push(parseDatasetSpec(argv[++i] ?? ''));
    } else if (a === '--repo') {
      repo = argv[++i];
      if (!repo) throw new Error('--repo: missing value');
    } else {
      throw new Error(`unknown arg: ${a}\n\n${usage()}`);
    }
  }
  if (datasets.length === 0 && repo) {
    datasets.push(...defaultDatasetsForRepo(repo));
  }
  if (datasets.length === 0) {
    throw new Error(`no datasets configured\n\n${usage()}`);
  }
  // Detect duplicate names.
  const seen = new Set<string>();
  for (const d of datasets) {
    if (seen.has(d.name)) throw new Error(`duplicate --dataset name: ${d.name}`);
    seen.add(d.name);
  }
  return { port, host, datasets };
}

function resolveImagePath(ds: DatasetConfig, entry: RawEntry): string {
  if (ds.images.kind === 'abs') {
    if (!entry.abs_frame_path) {
      throw new Error(`entry missing abs_frame_path in dataset ${ds.name}`);
    }
    return entry.abs_frame_path;
  }
  if (!entry.frame) {
    throw new Error(`entry missing frame in dataset ${ds.name}`);
  }
  return join(ds.images.base, entry.frame);
}

function rowIdFor(ds: DatasetConfig, entry: RawEntry): string {
  if (ds.images.kind === 'abs') {
    const p = entry.abs_frame_path ?? '';
    // Last 3 path components so the batch directory disambiguates
    // frames that share a numeric name across batches
    // (e.g. emit-residuals-run2/0392/post.jpg vs
    // emit-residuals-run3/0392/post.jpg are distinct).
    return p.split('/').slice(-3).join('/');
  }
  return entry.frame ?? '';
}

async function readJsonl(path: string): Promise<RawEntry[]> {
  const text = await fs.readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawEntry);
}

async function readVerified(path: string): Promise<Map<string, VerifiedEntry>> {
  const result = new Map<string, VerifiedEntry>();
  try {
    const text = await fs.readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as VerifiedEntry;
      result.set(entry.frame, entry);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return result;
}

function isVerified(v: VerifiedEntry | undefined): boolean {
  if (!v) return false;
  return v.decision !== 'skip';
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface FrameRow {
  idx: number;
  frame_id: string;
  label: { visible: boolean; x: number | null; y: number | null } | null;
  algorithm_label: { x: number; y: number } | null;
  verified: VerifiedEntry | null;
  claimedByOther?: boolean;
}

async function buildFrameList(
  ds: DatasetConfig,
  filter: string,
  sessionId: string | null,
): Promise<FrameRow[]> {
  const entries = await readJsonl(ds.jsonlPath);
  const verifiedMap = await readVerified(ds.verifiedPath);
  const now = Date.now();
  if (sessionId !== null) pruneExpiredClaims(now);
  const rows: FrameRow[] = entries.map((e, idx) => {
    const cursor = e.cursor ?? null;
    const label =
      cursor == null
        ? null
        : {
            visible: cursor.visible,
            x: cursor.x ?? null,
            y: cursor.y ?? null,
          };
    const frameId = rowIdFor(ds, e);
    const row: FrameRow = {
      idx,
      frame_id: frameId,
      label,
      algorithm_label: e.algorithm_label ?? null,
      verified: verifiedMap.get(frameId) ?? null,
    };
    if (sessionId !== null) {
      row.claimedByOther = isClaimedByOther(ds.name, frameId, sessionId, now);
    }
    return row;
  });

  let filtered: FrameRow[];
  switch (filter) {
    case 'visible':
      filtered = rows.filter((r) => r.label?.visible === true);
      break;
    case 'absent':
      filtered = rows.filter((r) => r.label?.visible === false);
      break;
    case 'disagree50':
    case 'disagree100': {
      const threshold = filter === 'disagree50' ? 50 : 100;
      filtered = rows.filter((r) => {
        if (!r.label?.visible || !r.algorithm_label) return false;
        if (r.label.x == null || r.label.y == null) return false;
        return (
          distance(
            { x: r.label.x, y: r.label.y },
            r.algorithm_label,
          ) >= threshold
        );
      });
      break;
    }
    case 'all':
    default:
      filtered = rows;
  }
  return filtered.sort((a, b) => a.frame_id.localeCompare(b.frame_id));
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), 'application/json');
}

function streamFile(res: ServerResponse, path: string, contentType: string): void {
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  const stream = createReadStream(path);
  stream.on('error', () => {
    res.statusCode = 404;
    res.end('not found');
  });
  stream.pipe(res);
}

function buildHandler(datasets: DatasetConfig[]) {
  const byName = new Map(datasets.map((d) => [d.name, d]));

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      streamFile(res, join(HERE, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && path === '/app.js') {
      streamFile(res, join(HERE, 'app.js'), 'application/javascript; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && path === '/api/datasets') {
      const now = Date.now();
      pruneExpiredClaims(now);
      const list = await Promise.all(
        datasets.map(async (d) => {
          const entries = await readJsonl(d.jsonlPath);
          const verified = await readVerified(d.verifiedPath);
          // total = unique frame_ids (not raw source rows). The source
          // jsonl may contain duplicates; counting raw rows can leave
          // the user with a permanently-stuck N/M < 1 ratio.
          const uniqueIds = new Set(entries.map((e) => rowIdFor(d, e)));
          const doneCount = [...verified.values()].filter(isVerified).length;
          return { name: d.name, total: uniqueIds.size, verified: doneCount };
        }),
      );
      sendJson(res, 200, { datasets: list, activeRaters: activeSessionCount(now) });
      return;
    }
    if (req.method === 'GET' && path === '/api/frames') {
      const datasetName = url.searchParams.get('dataset') ?? datasets[0].name;
      const filter = url.searchParams.get('filter') ?? 'all';
      const sessionId = validateSessionId(url.searchParams.get('sessionId'));
      const ds = byName.get(datasetName);
      if (!ds) {
        sendJson(res, 400, { error: `unknown dataset ${datasetName}` });
        return;
      }
      sendJson(res, 200, await buildFrameList(ds, filter, sessionId));
      return;
    }
    if (req.method === 'POST' && path === '/api/heartbeat') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let payload: { sessionId?: unknown; dataset?: unknown; frameId?: unknown };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      const sessionId = validateSessionId(payload.sessionId);
      if (!sessionId) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      if (typeof payload.dataset !== 'string' || !byName.has(payload.dataset)) {
        sendJson(res, 400, { error: 'unknown dataset' });
        return;
      }
      if (typeof payload.frameId !== 'string' || !payload.frameId) {
        sendJson(res, 400, { error: 'missing frameId' });
        return;
      }
      claims.set(sessionId, {
        sessionId,
        dataset: payload.dataset,
        frameId: payload.frameId,
        lastSeenMs: Date.now(),
      });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/api/image') {
      const datasetName = url.searchParams.get('dataset') ?? '';
      const frameId = url.searchParams.get('frame_id') ?? '';
      const ds = byName.get(datasetName);
      if (!ds) {
        send(res, 400, `unknown dataset`, 'text/plain');
        return;
      }
      const entries = await readJsonl(ds.jsonlPath);
      const entry = entries.find((e) => rowIdFor(ds, e) === frameId);
      if (!entry) {
        send(res, 404, `frame not found`, 'text/plain');
        return;
      }
      streamFile(res, resolveImagePath(ds, entry), 'image/jpeg');
      return;
    }
    if (req.method === 'POST' && path === '/api/decision') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      let payload: {
        dataset: string;
        frame_id: string;
        decision: 'confirm' | 'correct' | 'absent' | 'skip';
        cursor?: { visible: boolean; x?: number; y?: number };
        sessionId?: string;
      };
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      const ds = byName.get(payload.dataset);
      if (!ds) {
        sendJson(res, 400, { error: `unknown dataset ${payload.dataset}` });
        return;
      }
      const entry: VerifiedEntry = {
        frame: payload.frame_id,
        source_dataset: ds.name,
        decision: payload.decision,
        decided_at: new Date().toISOString(),
      };
      if (payload.cursor) entry.cursor = payload.cursor;
      await fs.mkdir(dirname(ds.verifiedPath), { recursive: true });
      await fs.appendFile(ds.verifiedPath, JSON.stringify(entry) + '\n');
      // Release this session's claim on the frame so subsequent
      // navigation by this user (or any other) doesn't see it as
      // "claimed" by us.
      const sessionId = validateSessionId(payload.sessionId);
      if (sessionId) {
        const c = claims.get(sessionId);
        if (
          c &&
          c.dataset === ds.name &&
          c.frameId === payload.frame_id
        ) {
          claims.delete(sessionId);
        }
      }
      sendJson(res, 200, { ok: true, entry });
      return;
    }

    send(res, 404, 'not found', 'text/plain');
  };
}

let args: CliArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const handler = buildHandler(args.datasets);
const server = createServer((req, res) => {
  handler(req, res).catch((e) => {
    console.error('request error:', e);
    if (!res.headersSent) {
      send(res, 500, `error: ${(e as Error).message}`, 'text/plain');
    } else {
      res.end();
    }
  });
});

server.listen(args.port, args.host, () => {
  console.error(`label-review server: http://${args.host}:${args.port}/`);
  for (const d of args.datasets) {
    console.error(
      `  • ${d.name}: jsonl=${d.jsonlPath}, verified=${d.verifiedPath}, ` +
        `images=${d.images.kind === 'abs' ? 'abs' : `dir:${d.images.base}`}`,
    );
  }
});
