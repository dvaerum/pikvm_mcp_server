/**
 * TDD for the CLI option parser (src/cli.ts). Covers transport selection
 * (flag > env > default), the --http shorthand, host/port overrides, --help,
 * and validation of bad transport/port values.
 */
import { describe, expect, it } from 'vitest';
import { parseCliOptions, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from '../cli.js';

describe('parseCliOptions', () => {
  it('defaults to stdio with no args and no env', () => {
    const o = parseCliOptions([], {});
    expect(o.transport).toBe('stdio');
    expect(o.help).toBe(false);
  });

  it('--transport http selects http with default host/port', () => {
    const o = parseCliOptions(['--transport', 'http'], {});
    expect(o.transport).toBe('http');
    expect(o.host).toBe(DEFAULT_HTTP_HOST);
    expect(o.port).toBe(DEFAULT_HTTP_PORT);
  });

  it('--http is shorthand for --transport http', () => {
    expect(parseCliOptions(['--http'], {}).transport).toBe('http');
  });

  it('--host and --port override the defaults', () => {
    const o = parseCliOptions(['--http', '--host', '0.0.0.0', '--port', '9123'], {});
    expect(o.host).toBe('0.0.0.0');
    expect(o.port).toBe(9123);
  });

  it('falls back to env vars when the flags are absent', () => {
    const o = parseCliOptions([], {
      PIKVM_MCP_TRANSPORT: 'http',
      PIKVM_MCP_HOST: '1.2.3.4',
      PIKVM_MCP_PORT: '8080',
    });
    expect(o.transport).toBe('http');
    expect(o.host).toBe('1.2.3.4');
    expect(o.port).toBe(8080);
  });

  it('CLI flags win over env vars', () => {
    const o = parseCliOptions(['--transport', 'stdio', '--port', '5000'], {
      PIKVM_MCP_TRANSPORT: 'http',
      PIKVM_MCP_PORT: '8080',
    });
    expect(o.transport).toBe('stdio');
    expect(o.port).toBe(5000);
  });

  it('--help (and -h) set the help flag', () => {
    expect(parseCliOptions(['--help'], {}).help).toBe(true);
    expect(parseCliOptions(['-h'], {}).help).toBe(true);
  });

  it('rejects an unknown transport', () => {
    expect(() => parseCliOptions(['--transport', 'ftp'], {})).toThrow(/transport/i);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => parseCliOptions(['--http', '--port', 'abc'], {})).toThrow(/port/i);
    expect(() => parseCliOptions(['--http', '--port', '70000'], {})).toThrow(/port/i);
    expect(() => parseCliOptions(['--http', '--port', '0'], {})).toThrow(/port/i);
  });

  it('rejects unknown flags (strict CLI)', () => {
    expect(() => parseCliOptions(['--nope'], {})).toThrow();
  });

  it('target is undefined when neither the flag nor the env is set (main enforces required)', () => {
    expect(parseCliOptions([], {}).target).toBeUndefined();
  });

  it('--target ipad / desktop are accepted (auto is gone)', () => {
    expect(parseCliOptions(['--target', 'ipad'], {}).target).toBe('ipad');
    expect(parseCliOptions(['--target', 'desktop'], {}).target).toBe('desktop');
  });

  it('target falls back to PIKVM_TARGET env, and the flag wins over env', () => {
    expect(parseCliOptions([], { PIKVM_TARGET: 'desktop' }).target).toBe('desktop');
    expect(parseCliOptions(['--target', 'ipad'], { PIKVM_TARGET: 'desktop' }).target).toBe('ipad');
  });

  it('rejects an invalid target (including the removed "auto")', () => {
    expect(() => parseCliOptions(['--target', 'tablet'], {})).toThrow(/target/i);
    expect(() => parseCliOptions(['--target', 'auto'], {})).toThrow(/target/i);
  });
});
