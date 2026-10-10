import { describe, expect, it } from 'vitest';

describe('worker workspace', () => {
  it('starts with a valid workspace entry point', async () => {
    const worker = await import('./index.js');

    expect(worker).toBeDefined();
  });
});
