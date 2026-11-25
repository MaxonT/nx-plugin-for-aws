/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Tree } from '@nx/devkit';
import { matchGritQL } from './ast.js';

/**
 * A pattern matching `snippet` as a formatter may have left it: whitespace may
 * differ, or appear next to any punctuation, a trailing comma may have been
 * added or removed, and a string may be in single or double quotes.
 */
const formattedPattern = (snippet: string): RegExp => {
  const gap = '\\s*';
  let pattern = '';
  let previous = '';
  for (const char of snippet.trim()) {
    if (/\s/.test(char)) {
      if (!pattern.endsWith(gap)) pattern += gap;
      previous = ' ';
      continue;
    }
    const between = /\W/.test(char) || /\W/.test(previous);
    if (previous && between && !pattern.endsWith(gap)) pattern += gap;
    if (char === ',') {
      pattern += ',?';
    } else if (char === "'" || char === '"') {
      pattern += `['"]`;
    } else if (')]}'.includes(char)) {
      pattern += `,?${gap}\\${char}`;
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    previous = char;
  }
  return new RegExp(pattern);
};

export interface VendedEdit {
  /** The text the generator used to write */
  readonly from: string;
  /** The text it writes now */
  readonly to: string;
  /** Skip, rather than fail, when the old text is not there, as for a comment */
  readonly optional?: boolean;
}

/**
 * Applies each edit to `content` where its old text is found, as a formatter
 * may have left it. Returns the new content, or undefined when an edit's old
 * text is not there, and the file has diverged from what was generated.
 * An edit whose new text is already there is skipped, so applying the edits
 * again changes nothing.
 */
export const applyVendedEdits = (
  content: string,
  edits: readonly VendedEdit[],
): string | undefined => {
  let updated = content;
  const squash = (code: string) => code.replace(/[\s,]/g, '');
  for (const { from, to, optional } of edits) {
    const pattern = formattedPattern(from);
    const found = pattern.test(updated);
    // Already applied: the new text is there, and is not just the old text
    // with more around it
    if (
      formattedPattern(to).test(updated) &&
      (!found || squash(to).includes(squash(from)))
    ) {
      continue;
    }
    if (!found) {
      if (optional) continue;
      return undefined;
    }
    updated = updated.replace(pattern, () => to);
  }
  return updated;
};

export interface VendedShape {
  /** GritQL matching what the file has once migrated */
  readonly current: string;
  /** GritQL patterns the file as generated before matches, every one */
  readonly old: readonly string[];
}

/**
 * Applies `edits` to each file at `paths` that exists and is not migrated
 * already. A file is written only when GritQL finds the old shape, and every
 * edit applied; otherwise it is left alone and reported as a next step.
 */
export const migrateVendedFiles = async (
  tree: Tree,
  paths: readonly string[],
  shape: VendedShape,
  edits: readonly VendedEdit[],
  divergedStep: (path: string) => string,
): Promise<{ migrated: string[]; nextSteps: string[] }> => {
  const migrated: string[] = [];
  const nextSteps: string[] = [];
  for (const path of paths) {
    if (!tree.exists(path) || (await matchGritQL(tree, path, shape.current))) {
      continue;
    }
    let matches = true;
    for (const pattern of shape.old) {
      matches &&= await matchGritQL(tree, path, pattern);
    }
    const content = tree.read(path, 'utf-8') ?? '';
    const updated = matches ? applyVendedEdits(content, edits) : undefined;
    if (updated === undefined) {
      nextSteps.push(divergedStep(path));
    } else if (updated !== content) {
      tree.write(path, updated);
      migrated.push(path);
    }
  }
  return { migrated, nextSteps };
};
