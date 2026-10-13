import type {
  CollectionCategory,
  WorkspaceFolderFiles,
  WorkspaceItemKind,
  WorkspaceMergeChoices,
  WorkspaceMergeConflict,
  WorkspaceMergeNote,
  WorkspaceMergeResult,
} from '../types.js';
import {
  WORKSPACE_FOLDER_VERSION,
  WorkspaceFolderError,
  classify,
  parseObject,
  serialize,
  type Json,
} from './workspaceFolder.js';

// A three-way merge of workspace folders (workspaceFolder.ts): the common
// version (`base`), ours and theirs, each a whole folder's files. Each file is
// one item, so items merge whole:
//
// - changed on one side only: that side's version (a delete included);
// - the same on both sides: that;
// - deleted on one side and changed on the other: the changed one, noted;
// - changed differently on both sides: a conflict, decided by a choice of side
//   (resolveWorkspaceMerge).
//
// Then the result is made consistent, since each side's changes can be fine on
// their own and not together:
//
// - a folder whose parent folder is gone moves into its category's first root
//   collection (by order, then id), or becomes a root collection if there's none;
// - folders that ended up inside each other (each side moved one into the
//   other) are separated the same way, moving the one with the lowest id;
// - a request or connection whose collection is gone moves into its category's
//   first root collection; if there's none, the root collection it was under
//   (on the side that had it) is restored;
// - a response example whose request is gone is dropped.

const KINDS: Record<string, WorkspaceItemKind> = {
  workspace: 'workspace',
  collections: 'collection',
  requests: 'request',
  websocket: 'websocket',
  mcp: 'mcp',
  messaging: 'messaging',
  environments: 'environment',
  examples: 'example',
};

const ITEM_CATEGORIES: Partial<Record<WorkspaceItemKind, CollectionCategory>> = {
  request: 'api',
  websocket: 'websocket',
  mcp: 'mcp',
  messaging: 'messaging',
};

/** The folder's own files, each in canonical form, so equal items compare equal. */
function normalize(files: WorkspaceFolderFiles, side: string, required: boolean): WorkspaceFolderFiles {
  const out: WorkspaceFolderFiles = {};
  for (const [file, text] of Object.entries(files)) {
    if (!classify(file)) continue;
    out[file] = serialize(parseObject(`${side} ${file}`, text));
  }
  const workspace = out['workspace.json'];
  if (workspace === undefined) {
    if (required) throw new WorkspaceFolderError('invalid', `${side} workspace.json: missing.`);
  } else {
    const version = (JSON.parse(workspace) as Json).formatVersion;
    if (typeof version === 'number' && version > WORKSPACE_FOLDER_VERSION) {
      throw new WorkspaceFolderError(
        'tooNew',
        `This workspace folder uses a newer format (version ${version}; this version reads up to ${WORKSPACE_FOLDER_VERSION}). Update to read it.`,
      );
    }
  }
  return out;
}

function describe(file: string, text: string): { kind: WorkspaceItemKind; id: string; name: string } {
  const place = classify(file)!;
  const value = JSON.parse(text) as Json;
  return {
    kind: KINDS[place.kind],
    id: place.kind === 'workspace' ? String(value.id ?? '') : place.id,
    name: typeof value.name === 'string' ? value.name : '',
  };
}

/**
 * Merges two folders that grew from `base` (rules above). `base` may be empty
 * when they share no history: then every item both have differently is a
 * conflict. A folder in a newer format is refused (`WorkspaceFolderError`,
 * `tooNew`); files the format doesn't use are left out of the result.
 */
export function mergeWorkspaceFolders(
  base: WorkspaceFolderFiles,
  ours: WorkspaceFolderFiles,
  theirs: WorkspaceFolderFiles,
): WorkspaceMergeResult {
  const sides = {
    base: normalize(base, 'base', false),
    ours: normalize(ours, 'ours', true),
    theirs: normalize(theirs, 'theirs', true),
  };
  const merged: WorkspaceFolderFiles = {};
  const conflicts: WorkspaceMergeConflict[] = [];
  const kept: WorkspaceMergeNote[] = [];
  const paths = new Set([...Object.keys(sides.base), ...Object.keys(sides.ours), ...Object.keys(sides.theirs)]);
  for (const file of [...paths].sort()) {
    const b = sides.base[file];
    const o = sides.ours[file];
    const t = sides.theirs[file];
    if (o === t || t === b) {
      if (o !== undefined) merged[file] = o;
    } else if (o === b) {
      if (t !== undefined) merged[file] = t;
    } else if (o === undefined || t === undefined) {
      const text = (o ?? t)!;
      merged[file] = text;
      kept.push({ file, ...describe(file, text), change: 'keptEdit', side: o === undefined ? 'ours' : 'theirs' });
    } else {
      const mine = describe(file, o);
      conflicts.push({
        file,
        kind: mine.kind,
        id: mine.id,
        ours: { name: mine.name, text: o },
        theirs: { name: describe(file, t).name, text: t },
      });
    }
  }

  // Every side's collections, ours first, to bring one back from.
  const collections: WorkspaceFolderFiles = {};
  for (const side of [sides.ours, sides.theirs, sides.base]) {
    for (const [file, text] of Object.entries(side)) {
      if (file.startsWith('collections/') && collections[file] === undefined) collections[file] = text;
    }
  }
  const provisional = { ...merged };
  for (const conflict of conflicts) provisional[conflict.file] = conflict.ours.text;
  const fixed = makeConsistent(provisional, collections);
  return { files: fixed.files, conflicts, notes: [...kept, ...fixed.notes], merged, collections };
}

/**
 * The final folder of a merge: each conflict's chosen side, then made
 * consistent as the merge is. Every conflict needs a choice.
 */
export function resolveWorkspaceMerge(
  result: WorkspaceMergeResult,
  choices: WorkspaceMergeChoices,
): { files: WorkspaceFolderFiles; notes: WorkspaceMergeNote[] } {
  const files = { ...result.merged };
  for (const conflict of result.conflicts) {
    const choice = choices[conflict.file];
    if (choice !== 'ours' && choice !== 'theirs') {
      throw new Error(`Choose ours or theirs for ${conflict.file}.`);
    }
    files[conflict.file] = conflict[choice].text;
  }
  const fixed = makeConsistent(files, result.collections);
  return { files: fixed.files, notes: [...result.notes.filter((n) => n.change === 'keptEdit'), ...fixed.notes] };
}

// ---- Making the result consistent ------------------------------------------------

interface Entry {
  file: string;
  value: Json;
  changed: boolean;
}

function makeConsistent(
  input: WorkspaceFolderFiles,
  known: WorkspaceFolderFiles,
): { files: WorkspaceFolderFiles; notes: WorkspaceMergeNote[] } {
  const entries = new Map<string, Entry>();
  for (const [file, text] of Object.entries(input)) {
    entries.set(file, { file, value: JSON.parse(text) as Json, changed: false });
  }
  const notes: WorkspaceMergeNote[] = [];
  const note = (entry: Entry, change: WorkspaceMergeNote['change']) =>
    notes.push({ file: entry.file, ...describe(entry.file, serialize(entry.value)), change });

  const collections = () => [...entries.values()].filter((e) => e.file.startsWith('collections/'));
  const byId = () => new Map(collections().map((e) => [e.value.id as string, e]));
  const firstRoot = (category: unknown, exclude: Set<string>): Entry | undefined =>
    collections()
      .filter((e) => e.value.parentId === null && e.value.category === category && !exclude.has(e.value.id as string))
      .sort(
        (a, b) =>
          (a.value.order as number) - (b.value.order as number) ||
          (a.value.id as string).localeCompare(b.value.id as string),
      )[0];
  const toRoot = (entry: Entry, exclude: Set<string>) => {
    const target = firstRoot(entry.value.category, exclude);
    entry.value = target
      ? { ...entry.value, parentId: target.value.id }
      : { ...entry.value, parentId: null, kind: 'collection' };
    entry.changed = true;
    note(entry, 'moved');
  };

  // Folders whose parent is gone.
  for (const entry of collections()) {
    const parent = entry.value.parentId;
    if (parent !== null && !byId().has(parent as string)) toRoot(entry, new Set([entry.value.id as string]));
  }
  // Folders inside each other.
  for (const entry of collections()) {
    const map = byId();
    const chain: string[] = [];
    for (
      let at: Entry | undefined = entry;
      at && at.value.parentId !== null;
      at = map.get(at.value.parentId as string)
    ) {
      const id = at.value.id as string;
      if (chain.includes(id)) {
        const cycle = chain.slice(chain.indexOf(id)).sort();
        toRoot(map.get(cycle[0])!, new Set(cycle));
        break;
      }
      chain.push(id);
    }
  }
  // Requests and connections whose collection is gone.
  for (const entry of [...entries.values()]) {
    const category = ITEM_CATEGORIES[KINDS[classify(entry.file)!.kind]];
    if (!category || byId().has(entry.value.collectionId as string)) continue;
    const target = firstRoot(category, new Set()) ?? restoreRoot(entry, category, entries, known, note);
    entry.value = { ...entry.value, collectionId: target.value.id };
    entry.changed = true;
    note(entry, 'moved');
  }
  // Examples whose request is gone.
  for (const entry of [...entries.values()]) {
    if (entry.file.startsWith('examples/') && !entries.has(`requests/${entry.value.requestId as string}.json`)) {
      entries.delete(entry.file);
      note(entry, 'dropped');
    }
  }

  const files: WorkspaceFolderFiles = {};
  for (const [file, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    files[file] = entry.changed ? serialize(entry.value) : input[file];
  }
  return { files, notes };
}

/** Brings back the root collection an item was under (as any side last had
 * it, ours first), or a new one when none had it. */
function restoreRoot(
  item: Entry,
  category: CollectionCategory,
  entries: Map<string, Entry>,
  known: WorkspaceFolderFiles,
  note: (entry: Entry, change: WorkspaceMergeNote['change']) => void,
): Entry {
  let id = item.value.collectionId as string;
  const seen = new Set<string>();
  for (let text = known[`collections/${id}.json`]; text !== undefined && !seen.has(id);) {
    seen.add(id);
    const value = JSON.parse(text) as Json;
    if (value.parentId === null) {
      if (value.category !== category) break;
      const entry: Entry = { file: `collections/${id}.json`, value: { ...value, kind: 'collection' }, changed: true };
      entries.set(entry.file, entry);
      note(entry, 'restored');
      return entry;
    }
    id = value.parentId as string;
    text = known[`collections/${id}.json`];
  }
  const restoredId = `restored-${category}`;
  const entry: Entry = {
    file: `collections/${restoredId}.json`,
    value: { id: restoredId, name: 'Restored', kind: 'collection', category, parentId: null, order: 0 },
    changed: true,
  };
  entries.set(entry.file, entry);
  note(entry, 'restored');
  return entry;
}
