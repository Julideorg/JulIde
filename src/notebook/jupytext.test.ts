import { describe, expect, test } from "bun:test";
import {
  cellRangeAtLine,
  commentBody,
  detectDialect,
  formatMarkerLine,
  isNotebookSource,
  parseJupytext,
  parseMarkerLine,
  serializeJupytext,
  uncommentBody,
  type JupytextCell,
} from "./jupytext";

/** A file jupytext itself would produce. */
const CANONICAL = `# ---
# jupyter:
#   jupytext:
#     formats: ipynb,jl:percent
#     text_representation:
#       extension: .jl
#       format_name: percent
#       format_version: '1.3'
#   kernelspec:
#     display_name: Julia 1.11.2
#     language: julia
#     name: julia-1.11
# ---

# %% [markdown]
# # Fitting the model
# We start from the raw counts.

# %%
using Plots
x = 1:10

# %% Make the figure
plot(x, x .^ 2)
`;

describe("marker lines", () => {
  test("the space after %% is mandatory, as in jupytext", () => {
    // `# %%[markdown]` is not a marker at all — a detail that is easy to get wrong.
    expect(parseMarkerLine("# %%[markdown]")).toBeNull();
    expect(parseMarkerLine("# %% [markdown]")).not.toBeNull();
  });

  test("the bare forms are markers", () => {
    for (const line of ["# %%", "#%%", "  # %%", "# <codecell>", "# In[12]:", "# In[ ]:"]) {
      expect(parseMarkerLine(line)?.type).toBe("code");
    }
  });

  test("cell types are recognised in every spelling", () => {
    expect(parseMarkerLine("# %% [markdown]")?.type).toBe("markdown");
    expect(parseMarkerLine("# %% [md]")?.type).toBe("markdown");
    expect(parseMarkerLine("# %% [raw]")?.type).toBe("raw");
  });

  test("[md] round-trips as [md] rather than being normalised", () => {
    const parsed = parseMarkerLine("# %% [md]");
    expect(parsed?.regionName).toBe("md");
  });

  test("the type tag is found anywhere in the title, both orders", () => {
    // jupytext parses permissively and writes canonically; both of these are real.
    expect(parseMarkerLine('# %% Title [markdown] tags=["x"]')?.type).toBe("markdown");
    expect(parseMarkerLine('# %% [markdown] Title tags=["x"]')?.type).toBe("markdown");
  });

  test("title and metadata are split at the word holding the first =", () => {
    const p = parseMarkerLine('# %% Load the data tags=["hide"] slideshow={"x": 1}');
    expect(p?.title).toBe("Load the data");
    expect(p?.metadata).toEqual({ tags: '["hide"]', slideshow: '{"x": 1}' });
  });

  test("extra percents are Spyder sub-cell depth", () => {
    expect(parseMarkerLine("# %%% Sub")?.cellDepth).toBe(1);
    expect(parseMarkerLine("# %%%% Sub")?.cellDepth).toBe(2);
  });

  test("a marker is written back canonically: title, type, metadata", () => {
    // Only the marker-line fields matter here; the body fields are filled in
    // so this stays a real `JupytextCell` rather than a cast through `unknown`.
    const cell: JupytextCell = {
      type: "markdown",
      title: "Intro",
      metadata: { tags: '["hide"]' },
      cellDepth: 0,
      source: "",
      rawMarker: null,
      rawBody: [],
      dirty: false,
      implicit: false,
      legacy: false,
      range: { markerLine: 1, startLine: 1, endLine: 1 },
    };
    expect(formatMarkerLine(cell)).toBe('# %% Intro [markdown] tags=["hide"]');
  });
});

describe("comment escaping", () => {
  test("empty lines become a bare #, not '# '", () => {
    expect(commentBody("a\n\nb")).toEqual(["# a", "#", "# b"]);
  });

  test("uncommenting strips '# ', then '#', then gives up", () => {
    // The asymmetry that makes the round trip need rawBody.
    expect(uncommentBody(["# a", "#", "#b", "plain"])).toBe("a\n\nb\nplain");
  });
});

describe("parsing", () => {
  test("the YAML header is not a cell", () => {
    const doc = parseJupytext(CANONICAL);
    expect(doc.header).not.toBeNull();
    expect(doc.header?.lines[0]).toBe("jupyter:");
    expect(doc.cells).toHaveLength(3);
  });

  test("markdown bodies come back uncommented", () => {
    const doc = parseJupytext(CANONICAL);
    expect(doc.cells[0].type).toBe("markdown");
    expect(doc.cells[0].source).toBe("# Fitting the model\nWe start from the raw counts.");
  });

  test("code bodies are verbatim and trailing blanks are not part of the source", () => {
    const doc = parseJupytext(CANONICAL);
    expect(doc.cells[1].source).toBe("using Plots\nx = 1:10");
  });

  test("a marker title is kept", () => {
    expect(parseJupytext(CANONICAL).cells[2].title).toBe("Make the figure");
  });

  test("content before the first marker is an implicit code cell", () => {
    const doc = parseJupytext("using Pkg\n\n# %%\nx = 1\n");
    expect(doc.cells[0].implicit).toBe(true);
    expect(doc.cells[0].type).toBe("code");
    expect(doc.cells[0].source).toBe("using Pkg");
  });

  test("a file with no markers is a single implicit cell", () => {
    const doc = parseJupytext("x = 1\ny = 2\n");
    expect(doc.cells).toHaveLength(1);
    expect(doc.cells[0].implicit).toBe(true);
  });

  test("an empty file has no cells", () => {
    expect(parseJupytext("").cells).toHaveLength(0);
    expect(parseJupytext("\n\n").cells).toHaveLength(0);
  });

  test("a header-only file has no cells", () => {
    const doc = parseJupytext("# ---\n# jupyter:\n#   kernelspec:\n# ---\n");
    expect(doc.header).not.toBeNull();
    expect(doc.cells).toHaveLength(0);
  });
});

describe("string-aware scanning", () => {
  test("a ## heading inside a docstring does not split a cell", () => {
    // The original scanner did a plain startsWith("##") and split here.
    const src = '# %%\n"""\n## Examples\n"""\nf() = 1\n';
    const doc = parseJupytext(src);
    expect(doc.cells).toHaveLength(1);
    expect(doc.cells[0].source).toContain("## Examples");
  });

  test("a # %% inside a docstring does not split a cell", () => {
    const src = '# %%\ns = """\n# %% not a marker\n"""\n';
    expect(parseJupytext(src).cells).toHaveLength(1);
  });

  test("a marker inside a nested block comment does not split a cell", () => {
    const src = "# %%\n#= outer #= inner\n# %% still a comment\n=# =#\nx = 1\n";
    expect(parseJupytext(src).cells).toHaveLength(1);
  });
});

describe("dialects", () => {
  test("percent markers win", () => {
    expect(detectDialect("# %%\nx = 1\n")).toBe("percent");
    expect(isNotebookSource("# %%\nx = 1\n")).toBe(true);
  });

  test("a jupytext header alone is enough", () => {
    expect(detectDialect("# ---\n# jupytext:\n#   formats: ipynb,jl\n# ---\n")).toBe("percent");
  });

  test("julIDE's ## separator is recognised as legacy", () => {
    expect(detectDialect("## one\nx = 1\n## two\ny = 2\n")).toBe("legacy");
  });

  test("a plain script is neither", () => {
    expect(detectDialect("f(x) = x + 1\n")).toBe("none");
    expect(isNotebookSource("f(x) = x + 1\n")).toBe(false);
  });

  test("## does not split cells inside a percent notebook", () => {
    // Otherwise an ordinary `## TODO` comment would break a code cell in half.
    const doc = parseJupytext("# %%\nx = 1\n## just a comment\ny = 2\n");
    expect(doc.cells).toHaveLength(1);
  });

  test("legacy ## files still split, so existing users do not regress", () => {
    const doc = parseJupytext("## one\nx = 1\n## two\ny = 2\n");
    expect(doc.cells).toHaveLength(2);
    expect(doc.cells[0].legacy).toBe(true);
    expect(doc.cells[1].source).toBe("y = 2");
  });
});

describe("round trip", () => {
  const FIXTURES: Record<string, string> = {
    canonical: CANONICAL,
    "no trailing newline": "# %%\nx = 1",
    crlf: "# %%\r\nx = 1\r\n",
    "two blank lines between cells": "# %%\nx = 1\n\n\n# %%\ny = 2\n",
    "no space after hash": "#%%\nx = 1\n",
    "indented marker": "  # %%\n  x = 1\n",
    "spyder sub-cell": "# %%% Sub\nx = 1\n",
    "nbconvert codecell": "# <codecell>\nx = 1\n",
    "In[] marker": "# In[12]:\nx = 1\n",
    "unparseable metadata tail": "# %% Title key=1 !!garbage\nx = 1\n",
    "md region name": "# %% [md]\n# hi\n",
    "implicit leading cell": "using Pkg\n\n# %%\nx = 1\n",
    "markdown body with an uncommented line": "# %% [markdown]\n# hi\nnot commented\n",
    "legacy hashes": "## one\nx = 1\n## two\ny = 2\n",
    "docstring with hashes": '# %%\n"""\n## Examples\n"""\n',
    empty: "",
    "header only": "# ---\n# jupyter:\n#   kernelspec:\n#     name: julia\n# ---\n",
    "shebang and coding cookie":
      "#!/usr/bin/env julia\n# -*- coding: utf-8 -*-\n# ---\n# jupyter:\n# ---\n\n# %%\nx = 1\n",
    "trailing blank lines": "# %%\nx = 1\n\n\n",
    "windows crlf with header": "# ---\r\n# jupyter:\r\n# ---\r\n\r\n# %%\r\nx = 1\r\n",
  };

  for (const [name, text] of Object.entries(FIXTURES)) {
    test(`is byte-exact: ${name}`, () => {
      expect(serializeJupytext(parseJupytext(text))).toBe(text);
    });
  }

  test("an edited cell is re-derived while its neighbours stay verbatim", () => {
    const doc = parseJupytext(CANONICAL);
    doc.cells[1].source = "using Plots\nx = 1:20";
    doc.cells[1].dirty = true;
    const out = serializeJupytext(doc);

    expect(out).toContain("x = 1:20");
    // Everything else is untouched, including the marker's original spelling.
    expect(out).toContain("# %% Make the figure");
    expect(out).toContain("# # Fitting the model");
    expect(out.startsWith("# ---\n# jupyter:")).toBe(true);
  });

  test("a cell changed to markdown gets its body comment-escaped", () => {
    const doc = parseJupytext("# %%\nhello\n");
    doc.cells[0].type = "markdown";
    doc.cells[0].source = "hello";
    doc.cells[0].dirty = true;
    expect(serializeJupytext(doc)).toBe("# %% [markdown]\n# hello\n");
  });
});

describe("cellRangeAtLine", () => {
  // Body lines only, marker excluded — the contract the old getCellRange had.
  const doc = parseJupytext("# %%\nx = 1\ny = 2\n\n# %%\nz = 3\n");

  test("a line inside the first cell resolves to its body", () => {
    expect(cellRangeAtLine(doc, 2)).toEqual({ startLine: 2, endLine: 4 });
    expect(cellRangeAtLine(doc, 3)).toEqual({ startLine: 2, endLine: 4 });
  });

  test("the marker line itself belongs to the cell it introduces", () => {
    expect(cellRangeAtLine(doc, 5).startLine).toBe(6);
  });

  test("a line in the second cell resolves to the second cell", () => {
    expect(cellRangeAtLine(doc, 6)).toEqual({ startLine: 6, endLine: 6 });
  });
});
