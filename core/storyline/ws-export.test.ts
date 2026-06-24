import { describe, expect, it } from 'vitest';
import { buildClose, buildIdentify, parseExportFrame } from './ws-export';

describe('buildIdentify / buildClose', () => {
  it('frames identify with the bearer and id 0', () => {
    expect(JSON.parse(buildIdentify('JWT'))).toEqual({
      id: 0,
      jsonrpc: '2.0',
      method: 'identify',
      params: { token: 'JWT' },
    });
  });

  it('frames close', () => {
    expect(JSON.parse(buildClose())).toEqual({ jsonrpc: '2.0', method: 'close' });
  });
});

describe('parseExportFrame', () => {
  it('recognizes the identify result and its sessionId', () => {
    const f = parseExportFrame(
      '{"id":0,"jsonrpc":"2.0","result":{"sessionId":"0a99c190-ac48-4a72-be13-432724a9c228"}}',
    );
    expect(f).toEqual({
      kind: 'identified',
      id: 0,
      sessionId: '0a99c190-ac48-4a72-be13-432724a9c228',
    });
  });

  it('recognizes package:success and extracts the location url', () => {
    const frame =
      '{"jsonrpc":"2.0","method":"notify","params":{"type":"package:success","sender":"rise-distributor","payload":{"jobId":"8797","jobName":"package:raw","location":"https://articulateusercontent.eu/rise/packages/MZz6En9J_nkU8p-kKjZcMHbo-x5zhSX9/1byJv7hn/theming-course-raw-1byJv7hn.zip"}}}';
    expect(parseExportFrame(frame)).toEqual({
      kind: 'package-success',
      jobId: '8797',
      jobName: 'package:raw',
      location:
        'https://articulateusercontent.eu/rise/packages/MZz6En9J_nkU8p-kKjZcMHbo-x5zhSX9/1byJv7hn/theming-course-raw-1byJv7hn.zip',
    });
  });

  it('classifies a package:* failure notify as package-error', () => {
    const f = parseExportFrame(
      '{"jsonrpc":"2.0","method":"notify","params":{"type":"package:error","payload":{"jobId":"8797","message":"boom"}}}',
    );
    expect(f).toEqual({ kind: 'package-error', jobId: '8797', type: 'package:error', message: 'boom' });
  });

  it('returns other for unparseable, unrelated, or location-less frames', () => {
    expect(parseExportFrame('not json').kind).toBe('other');
    expect(parseExportFrame('{"method":"ping"}').kind).toBe('other');
    // package:success without a location is not actionable → other
    expect(
      parseExportFrame(
        '{"method":"notify","params":{"type":"package:success","payload":{"jobId":"1"}}}',
      ).kind,
    ).toBe('package-error'); // type starts with package: but no location → error branch
  });
});
