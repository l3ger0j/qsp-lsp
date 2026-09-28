// ── Locations tree ───────────────────────────────────────────────────
//
// The model behind the "QSP Locations" view: the project's locations
// grouped by folder and file, or as one alphabetical list. Pure, so the
// grouping and marking rules are unit-tested; the client turns the nodes
// into TreeItems.

/** A location as the server lists it (`qsp/listLocations`); lines are 0-based. */
export interface LocationItem {
  name: string;
  uri: string;
  line: number;
  endLine: number;
}

export type LocationGrouping = 'file' | 'flat';

export interface LocationNode {
  kind: 'location';
  id: string;
  name: string;
  uri: string;
  /** Header line, 0-based. Together with `uri` and `name` it is what location commands accept. */
  line: number;
  endLine: number;
  /** Workspace-relative file path, shown next to the name in the flat list. */
  relPath: string;
  /** The game starts here: the first location of the main file. */
  isStart: boolean;
  errors: number;
  warnings: number;
}

export interface FileNode {
  kind: 'file';
  id: string;
  label: string;
  uri: string;
  relPath: string;
  children: LocationNode[];
}

export interface FolderNode {
  kind: 'folder';
  id: string;
  label: string;
  relPath: string;
  children: Array<FolderNode | FileNode>;
}

export type LocationTreeNode = FolderNode | FileNode | LocationNode;

/** A diagnostic reduced to what the counts need; `line` is 0-based. */
export interface DiagnosticMark {
  line: number;
  severity: 'error' | 'warning' | 'other';
}

export interface LocationTreeOptions {
  grouping: LocationGrouping;
  /** Workspace-relative, `/`-separated path of a file URI. */
  relPath: (uri: string) => string;
  /** URI of the file the game starts from; its first location is marked. */
  startFileUri?: string;
  diagnostics?: (uri: string) => DiagnosticMark[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Errors and warnings whose first line falls inside `[startLine, endLine]`. */
export function countDiagnostics(marks: DiagnosticMark[], startLine: number, endLine: number): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const m of marks) {
    if (m.line < startLine || m.line > endLine) continue;
    if (m.severity === 'error') errors++;
    else if (m.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}

/** Build the tree's top-level nodes for `items`. */
export function buildLocationTree(items: LocationItem[], opts: LocationTreeOptions): LocationTreeNode[] {
  // The start location is the main file's first location in source order,
  // whatever the list's own order is.
  let start: LocationItem | undefined;
  for (const item of items) {
    if (item.uri === opts.startFileUri && (!start || item.line < start.line)) start = item;
  }

  const marksByUri = new Map<string, DiagnosticMark[]>();
  const toNode = (item: LocationItem): LocationNode => {
    let marks = marksByUri.get(item.uri);
    if (!marks) {
      marks = opts.diagnostics?.(item.uri) ?? [];
      marksByUri.set(item.uri, marks);
    }
    return {
      kind: 'location',
      id: `loc:${item.uri}#${item.line}`,
      name: item.name,
      uri: item.uri,
      line: item.line,
      endLine: item.endLine,
      relPath: opts.relPath(item.uri),
      isStart: item === start,
      ...countDiagnostics(marks, item.line, item.endLine),
    };
  };

  if (opts.grouping === 'flat') {
    return items.map(toNode).sort((a, b) => byName(a.name, b.name) || byName(a.relPath, b.relPath) || a.line - b.line);
  }

  const files = new Map<string, FileNode>();
  for (const item of items) {
    let file = files.get(item.uri);
    if (!file) {
      const relPath = opts.relPath(item.uri);
      file = { kind: 'file', id: `file:${item.uri}`, label: relPath.split('/').pop()!, uri: item.uri, relPath, children: [] };
      files.set(item.uri, file);
    }
    file.children.push(toNode(item));
  }

  const root: FolderNode = { kind: 'folder', id: 'folder:', label: '', relPath: '', children: [] };
  for (const file of files.values()) {
    file.children.sort((a, b) => a.line - b.line);
    let folder = root;
    const dirs = file.relPath.split('/').slice(0, -1);
    for (let i = 0; i < dirs.length; i++) {
      const relPath = dirs.slice(0, i + 1).join('/');
      let next = folder.children.find((c): c is FolderNode => c.kind === 'folder' && c.relPath === relPath);
      if (!next) {
        next = { kind: 'folder', id: `folder:${relPath}`, label: dirs[i], relPath, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push(file);
  }

  // Folders before files, each alphabetically, as the Explorer shows them.
  const sortFolder = (folder: FolderNode): void => {
    folder.children.sort((a, b) => (a.kind === b.kind ? byName(a.label, b.label) : a.kind === 'folder' ? -1 : 1));
    for (const c of folder.children) if (c.kind === 'folder') sortFolder(c);
  };
  sortFolder(root);
  return root.children;
}

/** Every node's parent, for TreeDataProvider.getParent; top-level nodes are absent. */
export function parentIndex(roots: LocationTreeNode[]): Map<string, LocationTreeNode> {
  const parents = new Map<string, LocationTreeNode>();
  const visit = (node: LocationTreeNode) => {
    if (node.kind === 'location') return;
    for (const child of node.children) {
      parents.set(child.id, node);
      visit(child);
    }
  };
  roots.forEach(visit);
  return parents;
}

/** The location node whose header is on `line` of `uri`, or that contains the line. */
export function findLocationNode(roots: LocationTreeNode[], uri: string, line: number): LocationNode | undefined {
  let found: LocationNode | undefined;
  const visit = (node: LocationTreeNode) => {
    if (found) return;
    if (node.kind === 'location') {
      if (node.uri === uri && line >= node.line && line <= node.endLine) found = node;
      return;
    }
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return found;
}
