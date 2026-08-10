import { describe, expect, test } from "bun:test";
import {
  combineInputsWithOutputs,
  formatterInvariant,
  jupytextToNotebook,
  mapOutputsToInputs,
  newNotebookSource,
  notebookToJupytext,
  pairedFormats,
  parseSimpleYaml,
  readNotebook,
  writeNotebook,
  type IpynbCell,
  type Notebook,
} from "./ipynb";
import { isNotebookSource, parseJupytext, serializeJupytext } from "./jupytext";

const code = (id: string, source: string, execCount: number | null = null): IpynbCell => ({
  id,
  cell_type: "code",
  metadata: {},
  source,
  outputs: execCount === null ? [] : [{ output_type: "stream", name: "stdout", text: "out\n" }],
  execution_count: execCount,
});

const nb = (cells: IpynbCell[]): Notebook => ({
  cells,
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

describe("nbformat on-disk shape", () => {
  test("source is stored line-split with the newlines kept", () => {
    // Python's splitlines(True). Getting this wrong makes every sync a whole-file diff.
    const json = writeNotebook(nb([code("c1", "a = 1\nb = 2\n")]));
    expect(json).toContain('"a = 1\\n"');
    expect(json).toContain('"b = 2\\n"');
  });

  test("keys are sorted and the file ends with a newline", () => {
    const json = writeNotebook(nb([code("c1", "x")]));
    expect(json.endsWith("\n")).toBe(true);
    expect(json.indexOf('"cells"')).toBeLessThan(json.indexOf('"metadata"'));
    expect(json.indexOf('"metadata"')).toBeLessThan(json.indexOf('"nbformat"'));
    // Within a cell too.
    expect(json.indexOf('"cell_type"')).toBeLessThan(json.indexOf('"id"'));
  });

  test("indent is one space, matching nbformat's json.dumps(indent=1)", () => {
    expect(writeNotebook(nb([code("c1", "x")]))).toContain('\n "cells": [');
  });

  test("reading rejoins the split lines", () => {
    const json = writeNotebook(nb([code("c1", "a = 1\nb = 2\n")]));
    expect(readNotebook(json).cells[0].source).toBe("a = 1\nb = 2\n");
  });

  test("a notebook round-trips byte-for-byte", () => {
    const json = writeNotebook(nb([code("c1", "a = 1\n"), code("c2", "b = 2\n", 3)]));
    expect(writeNotebook(readNotebook(json))).toBe(json);
  });

  test("an empty source becomes an empty list, not [''] ", () => {
    expect(writeNotebook(nb([code("c1", "")]))).toContain('"source": []');
  });
});

describe("formatterInvariant", () => {
  test("ignores whitespace and trailing commas", () => {
    expect(formatterInvariant("f(1, 2)")).toBe(formatterInvariant("f(1,2)"));
    expect(formatterInvariant("[\n  1,\n  2,\n]")).toBe(formatterInvariant("[1, 2]"));
  });

  test("does NOT ignore quotes or parentheses", () => {
    // jupytext strips those because *black* rewrites them; JuliaFormatter does not, and
    // stripping them would make `f(1)` collide with `f 1`.
    expect(formatterInvariant("f(1)")).not.toBe(formatterInvariant("f 1"));
    expect(formatterInvariant('"a"')).not.toBe(formatterInvariant("a"));
  });
});

describe("output reconciliation", () => {
  test("an unchanged cell keeps its outputs, execution count and id", () => {
    const previous = nb([code("old1", "x = 1\n", 1), code("old2", "y = 2\n", 2)]);
    const source = nb([code("new1", "x = 1\n"), code("new2", "y = 2\n")]);
    const merged = combineInputsWithOutputs(source, previous);

    expect(merged.cells[0].id).toBe("old1");
    expect((merged.cells[0] as { execution_count: number }).execution_count).toBe(1);
    expect((merged.cells[1] as { outputs: unknown[] }).outputs).toHaveLength(1);
  });

  test("an inserted cell gets no outputs and does not shift its neighbours'", () => {
    const previous = nb([code("old1", "x = 1\n", 1), code("old2", "y = 2\n", 2)]);
    const source = nb([code("n0", "x = 1\n"), code("n1", "inserted\n"), code("n2", "y = 2\n")]);
    const merged = combineInputsWithOutputs(source, previous);

    expect(merged.cells[0].id).toBe("old1");
    expect((merged.cells[1] as { outputs: unknown[] }).outputs).toHaveLength(0);
    // The watermark keeps the following cell aligned to its own outputs.
    expect(merged.cells[2].id).toBe("old2");
  });

  test("a deleted cell's outputs simply vanish", () => {
    const previous = nb([code("old1", "x = 1\n", 1), code("old2", "y = 2\n", 2)]);
    const merged = combineInputsWithOutputs(nb([code("n0", "y = 2\n")]), previous);
    expect(merged.cells).toHaveLength(1);
    expect(merged.cells[0].id).toBe("old2");
  });

  test("reordered cells still find their own outputs", () => {
    const previous = nb([code("old1", "x = 1\n", 1), code("old2", "y = 2\n", 2)]);
    const merged = combineInputsWithOutputs(
      nb([code("n0", "y = 2\n"), code("n1", "x = 1\n")]),
      previous,
    );
    expect(merged.cells[0].id).toBe("old2");
    expect(merged.cells[1].id).toBe("old1");
  });

  test("duplicate identical cells get their own outputs in order", () => {
    const previous = nb([code("old1", "f()\n", 1), code("old2", "f()\n", 2)]);
    const merged = combineInputsWithOutputs(
      nb([code("n0", "f()\n"), code("n1", "f()\n")]),
      previous,
    );
    expect(merged.cells[0].id).toBe("old1");
    expect(merged.cells[1].id).toBe("old2");
  });

  test("an edited cell keeps its outputs but is marked stale", () => {
    // jupytext's rule 4. Dropping would mean a typo fix silently discards a plot.
    const previous = nb([code("old1", "plot(x)\n", 1)]);
    const merged = combineInputsWithOutputs(nb([code("n0", "plot(y)\n")]), previous);

    expect((merged.cells[0] as { outputs: unknown[] }).outputs).toHaveLength(1);
    expect(merged.cells[0].metadata.julide).toEqual({ staleOutputs: true });
  });

  test("editedCells: 'drop' discards them instead", () => {
    const previous = nb([code("old1", "plot(x)\n", 1)]);
    const merged = combineInputsWithOutputs(nb([code("n0", "plot(y)\n")]), previous, {
      editedCells: "drop",
    });
    expect((merged.cells[0] as { outputs: unknown[] }).outputs).toHaveLength(0);
  });

  test("re-editing a cell back to its old text clears the stale mark", () => {
    const previous = nb([code("old1", "plot(x)\n", 1)]);
    previous.cells[0].metadata = { julide: { staleOutputs: true } };
    const merged = combineInputsWithOutputs(nb([code("n0", "plot(x)\n")]), previous);
    expect(merged.cells[0].metadata.julide).toBeUndefined();
  });

  test("a markdown cell never claims a code cell's outputs", () => {
    const previous = nb([code("old1", "x = 1\n", 1)]);
    const source: Notebook = nb([
      { id: "m", cell_type: "markdown", metadata: {}, source: "x = 1\n" },
    ]);
    expect(mapOutputsToInputs(source.cells, previous.cells)).toEqual([null]);
  });
});

describe("jupytext ⇄ notebook", () => {
  const SOURCE = `# ---
# jupyter:
#   jupytext:
#     formats: ipynb,jl:percent
#   kernelspec:
#     display_name: Julia 1.11.2
#     language: julia
#     name: julia-1.11
# ---

# %% [markdown]
# # Title

# %%
x = 1
`;

  test("cells convert with their types preserved", () => {
    const notebook = jupytextToNotebook(parseJupytext(SOURCE));
    expect(notebook.cells.map((c) => c.cell_type)).toEqual(["markdown", "code"]);
    expect(notebook.cells[0].source).toBe("# Title");
    expect(notebook.cells[1].source).toBe("x = 1");
  });

  test("the header's kernelspec reaches notebook metadata", () => {
    const notebook = jupytextToNotebook(parseJupytext(SOURCE));
    expect(notebook.metadata.kernelspec).toMatchObject({ name: "julia-1.11", language: "julia" });
  });

  test("language_info is synthesized when there is no previous notebook", () => {
    const notebook = jupytextToNotebook(parseJupytext(SOURCE));
    expect(notebook.metadata.language_info).toMatchObject({ name: "julia" });
  });

  test("non-header metadata is carried over from the previous notebook", () => {
    // `widgets` lives only in the .ipynb; the .jl has no way to express it, so
    // regenerating without carrying it would delete it on every save.
    const previous: Notebook = {
      ...nb([]),
      metadata: { widgets: { state: {} }, language_info: { name: "julia", version: "1.11.2" } },
    };
    const notebook = jupytextToNotebook(parseJupytext(SOURCE), previous);
    expect(notebook.metadata.widgets).toEqual({ state: {} });
    expect(notebook.metadata.language_info).toMatchObject({ version: "1.11.2" });
  });

  test("converting a notebook back produces a jupytext file julIDE recognises", () => {
    const notebook = jupytextToNotebook(parseJupytext(SOURCE));
    const text = notebookToJupytext(notebook);
    expect(isNotebookSource(text)).toBe(true);
    expect(pairedFormats(text)).toBe("ipynb,jl:percent");

    const back = parseJupytext(text);
    expect(back.cells.map((c) => c.type)).toEqual(["markdown", "code"]);
    expect(back.cells[0].source).toBe("# Title");
    expect(back.cells[1].source).toBe("x = 1");
  });
});

describe("the YAML subset", () => {
  test("reads nested scalars", () => {
    const root = parseSimpleYaml([
      "jupyter:",
      "  jupytext:",
      "    formats: ipynb,jl:percent",
      "    text_representation:",
      "      format_version: '1.3'",
    ]);
    const jupytext = (root.jupyter as Record<string, Record<string, unknown>>).jupytext;
    expect(jupytext.formats).toBe("ipynb,jl:percent");
    // Quoted so YAML does not read it as a float; the quotes must not survive.
    expect((jupytext.text_representation as Record<string, string>).format_version).toBe("1.3");
  });

  test("pairedFormats returns null when nothing is declared", () => {
    expect(pairedFormats("# %%\nx = 1\n")).toBeNull();
    expect(pairedFormats("# ---\n# jupyter:\n#   kernelspec:\n# ---\n")).toBeNull();
  });
});

describe("newNotebookSource", () => {
  test("is a valid jupytext notebook with a markdown and a code cell", () => {
    const text = newNotebookSource({ displayName: "Julia 1.11.2", name: "julia-1.11" });
    expect(isNotebookSource(text)).toBe(true);
    expect(pairedFormats(text)).toBe("ipynb,jl:percent");

    const doc = parseJupytext(text);
    expect(doc.cells.map((c) => c.type)).toEqual(["markdown", "code"]);
  });

  test("round-trips byte-exactly, like any other jupytext file", () => {
    const text = newNotebookSource();
    expect(serializeJupytext(parseJupytext(text))).toBe(text);
  });
});
