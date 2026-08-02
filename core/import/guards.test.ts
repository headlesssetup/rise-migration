import { describe, it, expect } from 'vitest';
import {
  checkSourceNotTarget,
  planeFromHost,
  describeTarget,
} from './guards';

describe('planeFromHost', () => {
  it('detects EU and US planes', () => {
    expect(planeFromHost('rise.eu.articulate.com')).toBe('eu');
    expect(planeFromHost('rise.articulate.com')).toBe('us');
    expect(planeFromHost(null)).toBe(null);
  });
});

describe('checkSourceNotTarget', () => {
  const src = { name: 'INTEA Team', sub: 'auth0|123', plane: 'us' as const };

  it('refuses with no target', () => {
    const v = checkSourceNotTarget(src, undefined);
    expect(v.ok).toBe(false);
  });

  it('blocks same-account (by sub) without override', () => {
    const v = checkSourceNotTarget(src, { ...src });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.sameAccount).toBe(true);
  });

  it('allows same-account WITH explicit override', () => {
    const v = checkSourceNotTarget(src, { ...src }, true);
    expect(v.ok).toBe(true);
  });

  it('allows a genuinely different target', () => {
    const v = checkSourceNotTarget(src, {
      name: 'EU Team',
      sub: 'auth0|999',
      plane: 'eu',
    });
    expect(v.ok).toBe(true);
  });

  it('flags same plane in the reason for a different account', () => {
    const v = checkSourceNotTarget(src, {
      name: 'Other US',
      sub: 'auth0|999',
      plane: 'us',
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.reason).toMatch(/same plane/i);
  });

  it('matches by name when neither side has a sub', () => {
    const v = checkSourceNotTarget(
      { name: 'Acme', plane: 'us' },
      { name: 'acme', plane: 'eu' },
    );
    expect(v.ok).toBe(false);
  });

  it('blocks by name when the target sub is not yet captured (safety-bias)', () => {
    // source recorded a sub; live target tab has no JWT identity yet (sub null)
    const v = checkSourceNotTarget(src, { name: 'INTEA Team', sub: null, plane: 'us' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.sameAccount).toBe(true);
  });

  it('allows (with caveat) when source identity is unrecorded', () => {
    const v = checkSourceNotTarget(undefined, { name: 'Target', sub: 'x' });
    expect(v.ok).toBe(true);
  });
});

describe('describeTarget', () => {
  it('renders name + plane', () => {
    expect(describeTarget({ name: 'EU Team', plane: 'eu' })).toBe('EU Team — EU');
    expect(describeTarget(undefined)).toMatch(/no target/i);
  });
});

describe('checkSourceNotTarget — why a same-account verdict fired', () => {
  it('names the JWT-sub match, and calls out a likely STALE identity when names differ', () => {
    // The real case: operator switched Rise accounts; the header-derived name
    // refreshed but the cached bearer (and its sub) still belonged to the source.
    const v = checkSourceNotTarget(
      { name: 'Sergey Snegirev branchtrack.com', sub: 'auth0|aaa', plane: 'eu' },
      { name: 'Konstantin S', sub: 'auth0|aaa', plane: 'eu' },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.matchedBy).toBe('sub');
      expect(v.reason).toMatch(/JWT sub/);
      expect(v.reason).toMatch(/account names differ/);
      expect(v.reason).toMatch(/reload the target Rise COURSE EDITOR tab/i);
    }
  });

  it('a genuine same-account write (same sub AND same name) says so plainly', () => {
    const v = checkSourceNotTarget(
      { name: 'Acme', sub: 'auth0|aaa', plane: 'eu' },
      { name: 'Acme', sub: 'auth0|aaa', plane: 'eu' },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.matchedBy).toBe('sub');
      expect(v.reason).not.toMatch(/names differ/);
    }
  });

  it('a name-only match reports the name (target JWT identity not captured yet)', () => {
    const v = checkSourceNotTarget(
      { name: 'Acme', sub: 'auth0|aaa', plane: 'us' },
      { name: 'acme', sub: null, plane: 'eu' },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.matchedBy).toBe('name');
      expect(v.reason).toMatch(/matched by account name/);
    }
  });

  it('different sub AND different name still passes cleanly', () => {
    const v = checkSourceNotTarget(
      { name: 'Sergey Snegirev branchtrack.com', sub: 'auth0|aaa', plane: 'eu' },
      { name: 'Konstantin S', sub: 'auth0|bbb', plane: 'eu' },
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/differs from source/);
  });
});
