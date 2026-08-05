import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, RefreshCw } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import type { JuliaOutputEvent } from "../../types";

interface TestResult {
  name: string;
  status: "pass" | "fail" | "error" | "running";
  message?: string;
}

// Parse Julia test output to extract @testset results
function parseTestOutput(lines: string[]): TestResult[] {
  const results: TestResult[] = [];
  for (const line of lines) {
    // Match "Test Summary:" section lines like "  name | Pass  Total"
    // Match individual test result lines
    const passMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\d+)\s*$/);
    if (passMatch) {
      const [, name, pass, total] = passMatch;
      results.push({
        name: name.trim(),
        status: parseInt(pass) === parseInt(total) ? "pass" : "fail",
        message: `${pass}/${total} passed`,
      });
      continue;
    }
    // Match "Test Failed" or error lines
    if (line.includes("Test Failed")) {
      const nameMatch = line.match(/Test Failed at .+:\d+\s+Expression:\s+(.+)/);
      results.push({
        name: nameMatch?.[1] ?? "Test",
        status: "fail",
        message: line.trim(),
      });
    }
    // Match testset summaries with errors
    const errorMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (errorMatch) {
      const [, name, pass, fail, error, total] = errorMatch;
      results.push({
        name: name.trim(),
        status: parseInt(fail) + parseInt(error) > 0 ? "fail" : "pass",
        message: `${pass} pass, ${fail} fail, ${error} error / ${total} total`,
      });
    }
  }
  return results;
}

export function TestRunnerPanel() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const [results, setResults] = useState<TestResult[]>([]);
  const [output, setOutput] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState("");

  const runTests = useCallback(async () => {
    if (!workspacePath) return;
    setRunning(true);
    setResults([{ name: "Running tests...", status: "running" }]);
    setOutput([]);
    setSummary("");

    const lines: string[] = [];

    const unlisten = await listen<JuliaOutputEvent>("julia-output", (event) => {
      const { kind, text } = event.payload;
      if (kind === "stdout" || kind === "stderr") {
        lines.push(text);
        setOutput([...lines]);
      }
      if (kind === "done") {
        const parsed = parseTestOutput(lines);
        setResults(
          parsed.length > 0
            ? parsed
            : [
                {
                  name: "Tests completed",
                  status: "pass",
                  message: "No structured output detected",
                },
              ],
        );
        const passCount = parsed.filter((r) => r.status === "pass").length;
        const failCount = parsed.filter((r) => r.status === "fail" || r.status === "error").length;
        setSummary(`${passCount} passed, ${failCount} failed`);
        setRunning(false);
        unlisten();
      }
    });

    try {
      await invoke("julia_eval", {
        code: `using Pkg; Pkg.test()`,
        projectPath: workspacePath,
      });
    } catch (e) {
      setResults([{ name: "Error", status: "error", message: String(e) }]);
      setRunning(false);
      unlisten();
    }
  }, [workspacePath]);

  return (
    <div className="test-runner-panel">
      <div className="test-runner-toolbar">
        <button
          className="test-runner-btn"
          onClick={runTests}
          disabled={running || !workspacePath}
          title="Run Tests"
          aria-label="Run Tests"
        >
          {running ? <RefreshCw size={13} className="spinning" /> : <Play size={13} />}
          <span>Run Tests</span>
        </button>
        {summary && <span className="test-runner-summary">{summary}</span>}
      </div>

      <div className="test-runner-results">
        {results.map((r, i) => (
          <div key={i} className={`test-result-item test-result-${r.status}`}>
            <span className="test-result-icon">
              {r.status === "pass"
                ? "✓"
                : r.status === "fail"
                  ? "✕"
                  : r.status === "running"
                    ? "..."
                    : "!"}
            </span>
            <span className="test-result-name">{r.name}</span>
            {r.message && <span className="test-result-message">{r.message}</span>}
          </div>
        ))}
      </div>

      {output.length > 0 && (
        <div className="test-runner-output">
          {output.map((line, i) => (
            <div key={i} className="test-output-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
