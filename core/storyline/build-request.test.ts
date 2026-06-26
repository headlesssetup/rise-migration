import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_BUNDLES,
  DEFAULT_LMS_DRIVER_VERSION,
  buildRawExportRequest,
  parseBuildAck,
} from './build-request';

describe('buildRawExportRequest', () => {
  const args = {
    courseId: 'MZz6En9J_nkU8p-kKjZcMHbo-x5zhSX9',
    title: 'Theming course',
    websocketSessionId: '0a99c190-ac48-4a72-be13-432724a9c228',
  };

  it('targets the relative build/raw route (plane-agnostic, url-encoded id)', () => {
    const { spec } = buildRawExportRequest(args);
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe(
      '/api/rise-runtime/build/MZz6En9J_nkU8p-kKjZcMHbo-x5zhSX9/raw',
    );
    expect(spec.url.startsWith('http')).toBe(false);
  });

  it('omits the bearer (build/raw is cookie-authed) but keeps cookies', () => {
    const { spec } = buildRawExportRequest(args);
    expect(spec.omitBearer).toBe(true);
    expect(spec.noAuth).toBeUndefined(); // cookies still sent
  });

  it('reproduces the captured payload field-for-field', () => {
    const { spec, websocketSessionId } = buildRawExportRequest(args);
    expect(websocketSessionId).toBe(args.websocketSessionId);
    const body = JSON.parse(spec.body!);
    expect(body).toEqual({
      exportType: 'raw',
      isRemotePackage: false,
      format: 'zip',
      completionPercentage: 100,
      disableCoverPage: false,
      enableExitCourse: false,
      enableTelemetryCollection: false,
      identifier: 'MZz6En9J_nkU8p-kKjZcMHbo-x5zhSX9_rise',
      loadOnlyInLMS: false,
      quizId: null,
      reporting: 'passed-incomplete',
      storylineId: null,
      title: 'Theming course',
      bundles: { ...DEFAULT_EXPORT_BUNDLES },
      lmsDriverVersion: DEFAULT_LMS_DRIVER_VERSION,
      riseDistributor: true,
      websocketSessionId: '0a99c190-ac48-4a72-be13-432724a9c228',
    });
  });

  it('mints a uuid websocketSessionId when none is given', () => {
    const a = buildRawExportRequest({ courseId: 'c', title: 't' });
    const b = buildRawExportRequest({ courseId: 'c', title: 't' });
    expect(a.websocketSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(a.websocketSessionId).not.toBe(b.websocketSessionId);
    expect(JSON.parse(a.spec.body!).websocketSessionId).toBe(a.websocketSessionId);
  });

  it('accepts overridden bundles + driver version (version drift)', () => {
    const bundles = {
      rise_frontend: 'aaa',
      learn_distribution_frontend: 'bbb',
      mondrian: 'ccc',
      sandbox: 'ddd',
    };
    const { spec } = buildRawExportRequest({ ...args, bundles, lmsDriverVersion: '9.9.9' });
    const body = JSON.parse(spec.body!);
    expect(body.bundles).toEqual(bundles);
    expect(body.lmsDriverVersion).toBe('9.9.9');
  });
});

describe('parseBuildAck', () => {
  it('parses the captured ack', () => {
    expect(parseBuildAck('{"jobId":"8797","riseDistributor":true}')).toEqual({
      jobId: '8797',
      riseDistributor: true,
    });
  });

  it('coerces a numeric jobId to string', () => {
    expect(parseBuildAck('{"jobId":8797}').jobId).toBe('8797');
  });

  it('throws on malformed json or missing jobId', () => {
    expect(() => parseBuildAck('not json')).toThrow(/valid JSON/);
    expect(() => parseBuildAck('{"riseDistributor":true}')).toThrow(/no jobId/);
    expect(() => parseBuildAck('null')).toThrow(/not an object/);
  });
});
