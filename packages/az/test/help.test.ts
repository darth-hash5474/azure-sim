import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpFor } from '../src/help';
import { COMMANDS } from '../src/registry';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'help');

describe('az <command> --help matches the real Azure CLI', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));

  it('has a fixture for every command', () => {
    expect(files.length).toBe(Object.keys(COMMANDS).length);
  });

  for (const file of files) {
    const path = file.replace(/\.txt$/, '').replace(/_/g, ' ');
    it(path, () => {
      const expected = readFileSync(join(FIXTURES, file), 'utf8').replace(/\n$/, '');
      expect(helpFor(path)?.join('\n')).toBe(expected);
    });
  }
});
