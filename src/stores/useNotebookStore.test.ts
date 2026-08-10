import { describe, expect, test, beforeEach } from "bun:test";
import { hashSource, useNotebookStore, type CellOutput } from "./useNotebookStore";

beforeEach(() => {
  useNotebookStore.getState().reset();
});

const stream = (id: string, text: string, name: "stdout" | "stderr" = "stdout"): CellOutput => ({
  id,
  kind: "stream",
  name,
  text,
});

describe("execution bookkeeping", () => {
  test("beginExec maps the exec id to the cell and clears the old output", () => {
    const s = useNotebookStore.getState();
    s.appendOutput("c1", stream("o1", "old\n"));
    s.beginExec("x1", "c1", "hash");

    const state = useNotebookStore.getState();
    expect(state.execToCell["x1"]).toBe("c1");
    // Re-running replaces rather than appends — what Jupyter does, and what anyone
    // re-running a plot expects.
    expect(state.cells["c1"].outputs).toEqual([]);
    expect(state.cells["c1"].status).toBe("queued");
    expect(state.cells["c1"].stale).toBe(false);
  });

  test("status and execution count are tracked per cell", () => {
    const s = useNotebookStore.getState();
    s.beginExec("x1", "c1", "h");
    s.setCellStatus("c1", "running");
    expect(useNotebookStore.getState().cells["c1"].status).toBe("running");
    s.setCellStatus("c1", "ok", 7);
    expect(useNotebookStore.getState().cells["c1"].executionCount).toBe(7);
  });

  test("an omitted execution count leaves the previous one alone", () => {
    const s = useNotebookStore.getState();
    s.setCellStatus("c1", "ok", 3);
    s.setCellStatus("c1", "running");
    expect(useNotebookStore.getState().cells["c1"].executionCount).toBe(3);
  });
});

describe("output coalescing", () => {
  test("consecutive stream chunks of the same name merge into one entry", () => {
    // One Julia backtrace arrives as ~25 chunks; one DOM node each would be absurd.
    const s = useNotebookStore.getState();
    s.appendOutput("c1", stream("o1", "a"));
    s.appendOutput("c1", stream("o2", "b"));
    s.appendOutput("c1", stream("o3", "c"));

    const outputs = useNotebookStore.getState().cells["c1"].outputs;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].text).toBe("abc");
  });

  test("stdout and stderr stay separate", () => {
    const s = useNotebookStore.getState();
    s.appendOutput("c1", stream("o1", "out", "stdout"));
    s.appendOutput("c1", stream("o2", "err", "stderr"));
    expect(useNotebookStore.getState().cells["c1"].outputs).toHaveLength(2);
  });

  test("a non-stream output breaks the run", () => {
    const s = useNotebookStore.getState();
    s.appendOutput("c1", stream("o1", "before"));
    s.appendOutput("c1", { id: "o2", kind: "result", text: "42" });
    s.appendOutput("c1", stream("o3", "after"));
    const outputs = useNotebookStore.getState().cells["c1"].outputs;
    expect(outputs.map((o) => o.kind)).toEqual(["stream", "result", "stream"]);
  });

  test("output count is capped so a runaway loop cannot wedge the editor", () => {
    const s = useNotebookStore.getState();
    for (let i = 0; i < 500; i++) {
      s.appendOutput("c1", { id: `o${i}`, kind: "result", text: String(i) });
    }
    expect(useNotebookStore.getState().cells["c1"].outputs.length).toBeLessThanOrEqual(200);
  });
});

describe("staleness", () => {
  test("marking stale does not drop the outputs", () => {
    // A one-character fix must not silently discard a thirty-second plot.
    const s = useNotebookStore.getState();
    s.beginExec("x1", "c1", "h");
    s.appendOutput("c1", stream("o1", "a plot"));
    s.markStale("c1", true);

    const cell = useNotebookStore.getState().cells["c1"];
    expect(cell.stale).toBe(true);
    expect(cell.outputs).toHaveLength(1);
  });

  test("clearing outputs also clears staleness", () => {
    const s = useNotebookStore.getState();
    s.beginExec("x1", "c1", "h");
    s.appendOutput("c1", stream("o1", "x"));
    s.markStale("c1", true);
    s.clearOutputs("c1");
    const cell = useNotebookStore.getState().cells["c1"];
    expect(cell.outputs).toEqual([]);
    expect(cell.stale).toBe(false);
  });
});

describe("forgetting deleted cells", () => {
  test("drops the cell and every exec mapping pointing at it", () => {
    const s = useNotebookStore.getState();
    s.beginExec("x1", "c1", "h");
    s.beginExec("x2", "c2", "h");
    s.forgetCells(["c1"]);

    const state = useNotebookStore.getState();
    expect(state.cells["c1"]).toBeUndefined();
    expect(state.cells["c2"]).toBeDefined();
    // Otherwise a late message for x1 would resurrect a cell that no longer exists.
    expect(state.execToCell["x1"]).toBeUndefined();
    expect(state.execToCell["x2"]).toBe("c2");
  });
});

describe("hashSource", () => {
  test("is stable and distinguishes a one-character change", () => {
    expect(hashSource("x = 1")).toBe(hashSource("x = 1"));
    expect(hashSource("x = 1")).not.toBe(hashSource("x = 2"));
    expect(hashSource("")).toBe(hashSource(""));
  });
});
