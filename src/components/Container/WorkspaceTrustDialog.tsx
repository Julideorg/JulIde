import { ShieldAlert, Terminal, Container as ContainerIcon } from "lucide-react";
import { useTrustStore } from "../../stores/useTrustStore";

/**
 * Asks the user to approve the commands a dev container would run, before it runs them.
 *
 * The distinction the dialog makes visible is *where* each command executes.
 * `initializeCommand` runs on the host machine — that is the one that turns opening
 * someone else's repository into arbitrary code execution. Container-side commands are
 * shown too, but they are far less dangerous and are labelled as such.
 */
export function WorkspaceTrustDialog() {
  const pending = useTrustStore((s) => s.pending);
  const resolve = useTrustStore((s) => s.resolve);

  if (!pending) return null;

  const { workspacePath, status } = pending;
  const hostCommands = status.commands.filter((c) => c.runsOnHost);
  const containerCommands = status.commands.filter((c) => !c.runsOnHost);

  return (
    <div className="trust-overlay">
      <div
        className="trust-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trust-title"
      >
        <header className="trust-header">
          <ShieldAlert size={20} className="trust-icon" />
          <div>
            <h2 id="trust-title">Do you trust this workspace?</h2>
            <p className="trust-subtitle">
              <code>{workspacePath}</code>
            </p>
          </div>
        </header>

        <p className="trust-body">
          This folder&rsquo;s <code>devcontainer.json</code> declares commands that will run when
          the dev container starts. Review them before continuing — a repository you did not write
          can put anything here.
        </p>

        {hostCommands.length > 0 && (
          <section className="trust-section host">
            <h3>
              <Terminal size={13} /> Runs on <strong>this machine</strong>
              <span className="trust-risk-badge">High risk</span>
            </h3>
            <ul>
              {hostCommands.map((c, i) => (
                <li key={`${c.phase}-${i}`}>
                  <span className="trust-phase">{c.phase}</span>
                  <code className="trust-command">{c.command}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {containerCommands.length > 0 && (
          <section className="trust-section container">
            <h3>
              <ContainerIcon size={13} /> Runs inside the container
            </h3>
            <ul>
              {containerCommands.map((c, i) => (
                <li key={`${c.phase}-${i}`}>
                  <span className="trust-phase">{c.phase}</span>
                  <code className="trust-command">{c.command}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="trust-note">
          Your choice is remembered for this folder. If <code>devcontainer.json</code> changes later
          — including on a branch you pull — you will be asked again.
        </p>

        <footer className="trust-footer">
          <button type="button" onClick={() => resolve(false)} autoFocus>
            Don&rsquo;t trust
          </button>
          <button type="button" className="btn-danger" onClick={() => resolve(true)}>
            Trust and continue
          </button>
        </footer>
      </div>
    </div>
  );
}
