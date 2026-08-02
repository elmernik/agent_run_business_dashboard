/* Convert a legacy Blender add-on's bl_info dict into a 4.2+ blender_manifest.toml.
 *
 * Pure logic, no DOM, so it can be unit-tested under node without a browser and
 * without Blender. That matters here: this machine cannot run Blender at all
 * (aarch64, and Blender ships no Linux ARM64 build), so every claim this tool
 * makes has to be checkable from the Python source text alone.
 *
 * Deliberately conservative. Where the manifest needs something bl_info never
 * carried — a licence, an email, a Blender minimum that is actually >= 4.2 —
 * the converter emits a clearly marked placeholder and a TODO rather than a
 * confident guess, because a manifest that looks finished but is wrong costs
 * more than one that is obviously unfinished.
 */
(function (root) {
  'use strict';

  // --- A tolerant parser for the Python literal subset bl_info actually uses.
  // Regexes were tried first and lost: descriptions contain commas, braces and
  // apostrophes, so any pattern loose enough to match real add-ons also matched
  // halfway through a string. A scanner is longer but does not silently
  // mis-parse, which is the failure mode that matters.
  function parsePyLiteral(src, pos) {
    pos = pos || 0;

    function ws() {
      for (;;) {
        while (pos < src.length && /\s/.test(src[pos])) pos++;
        if (src[pos] === '#') { while (pos < src.length && src[pos] !== '\n') pos++; continue; }
        break;
      }
    }

    function str() {
      const q = src[pos];
      // Triple quotes first: ''' and """ would otherwise read as an empty string.
      const triple = src.substr(pos, 3);
      if (triple === q + q + q) {
        pos += 3;
        let out = '';
        while (pos < src.length && src.substr(pos, 3) !== triple) { out += src[pos]; pos++; }
        pos += 3;
        return out;
      }
      pos++;
      let out = '';
      while (pos < src.length && src[pos] !== q) {
        if (src[pos] === '\\') {
          const n = src[pos + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : n;
          pos += 2;
          continue;
        }
        out += src[pos];
        pos++;
      }
      pos++;
      // Python implicitly concatenates adjacent string literals, and long
      // descriptions in real add-ons are routinely written that way.
      const save = pos;
      ws();
      if (src[pos] === '"' || src[pos] === "'") return out + str();
      pos = save;
      return out;
    }

    function seq(close) {
      pos++;
      const out = [];
      for (;;) {
        ws();
        if (pos >= src.length) break;
        if (src[pos] === close) { pos++; break; }
        if (src[pos] === ',') { pos++; continue; }
        out.push(value());
      }
      return out;
    }

    function dict() {
      pos++;
      const out = {};
      for (;;) {
        ws();
        if (pos >= src.length) break;
        if (src[pos] === '}') { pos++; break; }
        if (src[pos] === ',') { pos++; continue; }
        const k = value();
        ws();
        if (src[pos] === ':') pos++;
        ws();
        out[k] = value();
      }
      return out;
    }

    function value() {
      ws();
      const c = src[pos];
      if (c === '"' || c === "'") return str();
      if (c === '{') return dict();
      if (c === '(') return seq(')');
      if (c === '[') return seq(']');
      if (/[-\d]/.test(c)) {
        let n = '';
        while (pos < src.length && /[-\d.]/.test(src[pos])) { n += src[pos]; pos++; }
        return parseFloat(n);
      }
      let w = '';
      while (pos < src.length && /[A-Za-z_]/.test(src[pos])) { w += src[pos]; pos++; }
      if (w === 'True') return true;
      if (w === 'False') return false;
      if (w === 'None') return null;
      if (w === '') pos++; // never stall on an unexpected character
      return w;
    }

    return { value: value(), pos: pos };
  }

  function extractBlInfo(source) {
    // Match an assignment at the start of a line so a mention of bl_info inside
    // a docstring or a comment does not win over the real one.
    const m = /^[ \t]*bl_info[ \t]*=[ \t]*\{/m.exec(source);
    if (!m) return null;
    const brace = source.indexOf('{', m.index);
    try {
      return parsePyLiteral(source, brace).value;
    } catch (e) {
      return null;
    }
  }

  // Blender's own add-on tag vocabulary. A tag outside this list is rejected at
  // upload, so an unmapped legacy category is reported rather than passed through.
  const TAGS = ['3D View', 'Add Curve', 'Add Mesh', 'Animation', 'Bake', 'Camera',
    'Compositing', 'Development', 'Game Engine', 'Geometry Nodes', 'Grease Pencil',
    'Import-Export', 'Lighting', 'Material', 'Modeling', 'Mesh', 'Node', 'Object',
    'Paint', 'Pipeline', 'Physics', 'Render', 'Rigging', 'Scene', 'Sculpt',
    'Sequencer', 'System', 'Text Editor', 'Tracking', 'User Interface', 'UV', 'VFX'];

  const TAG_ALIAS = {
    '3d view': '3D View', 'add curve': 'Add Curve', 'add mesh': 'Add Mesh',
    'animation': 'Animation', 'compositing': 'Compositing', 'development': 'Development',
    'game engine': 'Game Engine', 'import-export': 'Import-Export',
    'import export': 'Import-Export', 'lighting': 'Lighting', 'material': 'Material',
    'mesh': 'Mesh', 'node': 'Node', 'object': 'Object', 'paint': 'Paint',
    'physics': 'Physics', 'render': 'Render', 'rigging': 'Rigging', 'scene': 'Scene',
    'sequencer': 'Sequencer', 'system': 'System', 'text editor': 'Text Editor',
    'uv': 'UV', 'user interface': 'User Interface', 'interface': 'User Interface',
    'modeling': 'Modeling', 'sculpt': 'Sculpt', 'camera': 'Camera', 'bake': 'Bake',
    'geometry nodes': 'Geometry Nodes', 'grease pencil': 'Grease Pencil',
    'pipeline': 'Pipeline', 'tracking': 'Tracking', 'vfx': 'VFX'
  };

  function makeId(name) {
    let id = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // The platform requires a valid Python identifier: lowercase, no leading digit.
    if (!id) id = 'my_extension';
    if (/^\d/.test(id)) id = 'ext_' + id;
    return id;
  }

  function makeVersion(v) {
    if (Array.isArray(v)) {
      const p = v.map(function (n) { return Math.trunc(Number(n) || 0); });
      while (p.length < 3) p.push(0);
      return p.slice(0, 3).join('.');
    }
    if (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v)) {
      const p = v.split('.');
      while (p.length < 3) p.push('0');
      return p.slice(0, 3).join('.');
    }
    return null;
  }

  function makeTagline(desc) {
    let t = String(desc || '').replace(/\s+/g, ' ').trim();
    if (!t) return { value: null };
    const notes = [];
    if (t.length > 64) {
      // Cut on a word boundary; Blender rejects anything over 64 characters.
      const cut = t.slice(0, 64);
      const sp = cut.lastIndexOf(' ');
      t = (sp > 24 ? cut.slice(0, sp) : cut).trim();
      notes.push('Tagline was longer than the 64-character limit and has been shortened — reword it so it still reads as a sentence.');
    }
    if (/[.,;:!?]$/.test(t)) {
      t = t.replace(/[.,;:!?]+$/, '');
      notes.push('Removed trailing punctuation: Blender rejects a tagline that ends with it.');
    }
    return { value: t, notes: notes };
  }

  function tomlStr(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function convert(source) {
    const info = extractBlInfo(source);
    if (!info) {
      return {
        ok: false,
        error: 'No bl_info block found. Paste the whole __init__.py — the part that starts with `bl_info = {`.'
      };
    }

    const todos = [];
    const notes = [];
    const name = info.name || 'My Extension';
    if (!info.name) todos.push('`name` was missing from bl_info — set it by hand.');

    const id = makeId(name);
    const version = makeVersion(info.version);
    if (!version) todos.push('`version` was missing or not a (major, minor, patch) tuple — the manifest needs an exact three-part version.');

    const tag = makeTagline(info.description);
    if (tag.notes) tag.notes.forEach(function (n) { notes.push(n); });
    if (!tag.value) todos.push('`description` was missing — write a tagline of at most 64 characters, with no trailing full stop.');

    // bl_info's "blender" key is the MINIMUM version the add-on supported, and for
    // almost every legacy add-on that predates the extensions platform. Carrying
    // it over verbatim produces a manifest Blender refuses to install, so it is
    // raised to 4.2.0 and the change is stated rather than done quietly.
    let blenderMin = makeVersion(info.blender);
    if (!blenderMin) {
      blenderMin = '4.2.0';
      notes.push('No `blender` key in bl_info, so blender_version_min was set to 4.2.0 — the first version with the extensions platform.');
    } else {
      const parts = blenderMin.split('.').map(Number);
      if (parts[0] < 4 || (parts[0] === 4 && parts[1] < 2)) {
        notes.push('bl_info declared Blender ' + blenderMin + ', but extensions require 4.2.0 or newer, so blender_version_min was raised to 4.2.0. Your add-on may well still run on older Blender — it just cannot be shipped as an extension there.');
        blenderMin = '4.2.0';
      }
    }

    const rawCat = info.category ? String(info.category).toLowerCase().trim() : '';
    let tags = [];
    if (rawCat && TAG_ALIAS[rawCat]) {
      tags = [TAG_ALIAS[rawCat]];
    } else if (rawCat) {
      todos.push('Legacy category ' + JSON.stringify(info.category) + ' is not one of the tags the extensions platform accepts — pick the closest from the official list.');
    } else {
      todos.push('bl_info had no `category` — choose at least one tag from the official list.');
    }

    let maintainer = info.author ? String(info.author).trim() : '';
    if (!maintainer) {
      maintainer = 'Your Name <you@example.com>';
      todos.push('`author` was missing — set `maintainer` to "Your Name <you@example.com>".');
    } else if (!/<[^>]+@[^>]+>/.test(maintainer)) {
      maintainer = maintainer + ' <you@example.com>';
      todos.push('`maintainer` needs a contact email in angle brackets — replace you@example.com with a real address.');
    }

    const website = info.doc_url || info.wiki_url || info.tracker_url || '';

    // bl_info never carried a licence, and the platform will not accept a manifest
    // without one. GPL-2.0-or-later is the safe default only because an add-on
    // that imports bpy is already a GPL derivative in the Blender Foundation's
    // reading — but that is the author's call to confirm, not this tool's.
    todos.push('Confirm the licence. GPL-2.0-or-later is filled in because add-ons that import `bpy` are generally treated as GPL derivatives, but you are the one who has to stand behind it.');

    const lines = [];
    lines.push('schema_version = "1.0.0"');
    lines.push('');
    lines.push('id = ' + tomlStr(id));
    lines.push('version = ' + tomlStr(version || '1.0.0'));
    lines.push('name = ' + tomlStr(name));
    lines.push('tagline = ' + tomlStr(tag.value || 'A short description with no trailing full stop'));
    lines.push('maintainer = ' + tomlStr(maintainer));
    lines.push('');
    lines.push('type = "add-on"');
    lines.push('');
    if (website) lines.push('website = ' + tomlStr(website));
    lines.push('tags = [' + tags.map(tomlStr).join(', ') + ']');
    lines.push('');
    lines.push('blender_version_min = ' + tomlStr(blenderMin));
    lines.push('');
    lines.push('license = [');
    lines.push('  "SPDX:GPL-2.0-or-later",');
    lines.push(']');
    lines.push('');
    lines.push('[build]');
    lines.push('paths_exclude_pattern = [');
    lines.push('  "__pycache__/",');
    lines.push('  "/.git/",');
    lines.push('  "/*.zip",');
    lines.push(']');

    // Code changes the manifest cannot express. These are the ones that actually
    // break at install time, in the order they tend to bite.
    const code = [];
    code.push('Delete the `bl_info` dict. Blender 4.2+ reads the manifest instead, and leaving both means the two disagree the first time you bump a version.');
    if (/^\s*(?:from|import)\s+(?!\.)(?!bpy|mathutils|bmesh|bpy_extras|gpu|blf|bl_ui|bl_operators|aud|freestyle|idprop|imbuf|nodeitems_utils|rna_keymap_ui|addon_utils|os|sys|re|json|math|time|typing|dataclasses|collections|itertools|functools|pathlib|subprocess|shutil|tempfile|random|hashlib|struct|zipfile|csv|logging|enum|abc|copy|glob|ctypes|traceback|threading|queue|socket|urllib|http|base64|datetime|textwrap|uuid|pickle|array|numpy)\w+/m.test(source)) {
      code.push('You import a local module by plain name (e.g. `import my_utils`). Extensions load as real Python packages, so those must become relative imports: `from . import my_utils`. This is the single most common reason a converted add-on fails to enable.');
    }
    if (/sys\.path/.test(source)) {
      code.push('Remove the `sys.path` manipulation. It is what relative imports replace, and it can break other extensions.');
    }
    if (/\b(?:pip|subprocess)\b[\s\S]{0,80}install/.test(source)) {
      code.push('You appear to install a Python package at runtime. Extensions cannot do that — ship the dependency as a wheel and list it under `wheels` in the manifest.');
    }
    if (/urllib|requests|socket|http\.client/.test(source)) {
      code.push('You use the network. Declare it: add `[permissions]` with `network = "why you need it"`, or the listing will be flagged in review.');
    }
    code.push('Build and check it with `blender --command extension build`, then `blender --command extension validate <file>.zip`. This tool reads your source text; only Blender can confirm the result installs.');

    return {
      ok: true,
      id: id,
      manifest: lines.join('\n') + '\n',
      todos: todos,
      notes: notes,
      code: code,
      tags: tags
    };
  }

  const api = { convert: convert, extractBlInfo: extractBlInfo, makeId: makeId,
                makeVersion: makeVersion, makeTagline: makeTagline, TAGS: TAGS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlenderConvert = api;
})(typeof self !== 'undefined' ? self : this);
