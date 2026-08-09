import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { FileText, FolderOpen, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button, IconButton, type Tone } from "./Button";
import { Badge, Dot, EmptyState, Kbd, Panel, Spinner } from "./Panel";
import { Input } from "./Field";
import { Select } from "./Select";
import { Dialog } from "./Dialog";
import { Menu, MenuItem, MenuSeparator, Popover } from "./Popover";
import { ToastHost, toast } from "./Toast";
import { iconSize, palettes } from "../../themes/tokens";

/**
 * A single page showing every primitive in both themes.
 *
 * This is the reference for what the design system actually offers, so new UI
 * gets composed from it rather than hand-rolled — which is how the stylesheet
 * this replaced ended up with two interchangeable radii and sixty padding
 * combinations.
 */
const meta: Meta = {
  title: "Design System/Primitives",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

const TONES: Tone[] = ["neutral", "brand", "run", "pkg", "help", "shell"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontFamily: "var(--font-condensed)",
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-lo)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

/* Select is controlled-only, so each variant needs its own state holder. */

function ThemeSelect() {
  const [value, setValue] = useState("julide-dark");
  return (
    <Select
      label="Theme"
      value={value}
      onChange={setValue}
      options={[
        { value: "julide-dark", label: "julIDE Ink (dark)" },
        { value: "julide-light", label: "julIDE Paper (light)" },
      ]}
    />
  );
}

/** Long enough to hit the panel's max height, so the scroll and flip logic show up. */
function LongSelect() {
  const [value, setValue] = useState("v1.11");
  const versions = ["v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11", "v1.12", "nightly"];
  return (
    <Select
      label="Julia version"
      value={value}
      onChange={setValue}
      options={versions.map((v) => ({ value: v, label: v }))}
    />
  );
}

function DisabledOptionSelect() {
  const [value, setValue] = useState("fatou");
  return (
    <Select
      label="Language server"
      value={value}
      onChange={setValue}
      options={[
        { value: "fatou", label: "Fatou", hint: "built-in" },
        { value: "languageserver", label: "LanguageServer.jl" },
        { value: "jetls", label: "JETLS.jl", disabled: true },
      ]}
    />
  );
}

function ErrorSelect() {
  const [value, setValue] = useState("podman");
  return (
    <Select
      label="Container runtime"
      value={value}
      onChange={setValue}
      error="Podman was not found on PATH"
      options={[
        { value: "auto", label: "Auto Detect" },
        { value: "docker", label: "Docker" },
        { value: "podman", label: "Podman" },
      ]}
    />
  );
}

function Showcase() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div
      style={{
        padding: 32,
        background: "var(--surface-canvas)",
        color: "var(--fg-hi)",
        minHeight: "100vh",
        fontFamily: "var(--font-ui)",
      }}
    >
      <Row label="Julia REPL modes — the semantic palette">
        {TONES.map((tone) => (
          <span key={tone} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Dot tone={tone} />
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-mid)" }}>{tone}</span>
          </span>
        ))}
      </Row>

      <Row label="Button — filled">
        {TONES.map((tone) => (
          <Button key={tone} variant="filled" tone={tone}>
            {tone}
          </Button>
        ))}
      </Row>

      <Row label="Button — outline / ghost / disabled">
        <Button icon={<FolderOpen size={iconSize.sm} />}>Open folder</Button>
        <Button variant="ghost" tone="run" icon={<Play size={iconSize.sm} />}>
          Run
        </Button>
        <Button size="md">Medium</Button>
        <Button disabled>Disabled</Button>
      </Row>

      <Row label="Icon button">
        <IconButton label="Refresh">
          <RefreshCw size={iconSize.sm} />
        </IconButton>
        <IconButton label="Delete" tone="shell">
          <Trash2 size={iconSize.sm} />
        </IconButton>
        <IconButton label="Toggled" tone="run" aria-pressed="true">
          <Play size={iconSize.sm} />
        </IconButton>
      </Row>

      <Row label="Badge and shortcut">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
        <Badge tone="shell" count>
          12
        </Badge>
        <Kbd>⌘K</Kbd>
      </Row>

      <Row label="Fields">
        <div style={{ width: 220 }}>
          <Input label="Package" placeholder="Plots" hint="Added to the active environment" />
        </div>
        <div style={{ width: 220 }}>
          <Input label="Julia path" mono defaultValue="/usr/bin/julia" />
        </div>
        <div style={{ width: 220 }}>
          <Input label="Name" defaultValue="bad name" error="Must be a valid identifier" />
        </div>
        <div style={{ width: 220 }}>
          <ThemeSelect />
        </div>
      </Row>

      {/* The dropdown is the reason this component exists: a native <select> renders its
          popup with the platform's own widget, which stayed white in dark mode. Flip the
          Storybook theme toolbar to check both. */}
      <Row label="Select">
        <div style={{ width: 220 }}>
          <ThemeSelect />
        </div>
        <div style={{ width: 220 }}>
          <LongSelect />
        </div>
        <div style={{ width: 220 }}>
          <DisabledOptionSelect />
        </div>
        <div style={{ width: 220 }}>
          <ErrorSelect />
        </div>
      </Row>

      <Row label="Feedback">
        <Spinner />
        <Button onClick={() => toast.success("Package added", "Plots v1.40 is now available.")}>
          Success toast
        </Button>
        <Button
          onClick={() => toast.error("Could not start Julia", "Executable not found on PATH.")}
        >
          Error toast
        </Button>
        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      </Row>

      <Row label="Popover and menu">
        <Popover
          label="File actions"
          trigger={(props) => (
            <button {...props} className="ui-tone ui-btn ui-btn--outline ui-btn--sm">
              File actions
            </button>
          )}
        >
          {(close) => (
            <Menu label="File actions">
              <MenuItem icon={<FileText size={iconSize.sm} />} hint="⌘N" onSelect={close}>
                New file
              </MenuItem>
              <MenuItem icon={<FolderOpen size={iconSize.sm} />} onSelect={close}>
                Reveal in explorer
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={iconSize.sm} />} danger onSelect={close}>
                Delete
              </MenuItem>
            </Menu>
          )}
        </Popover>
      </Row>

      <Row label="Panel and empty state">
        <div
          style={{
            width: 320,
            height: 220,
            border: "1px solid var(--hairline)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <Panel
            title="Plots"
            actions={
              <IconButton label="Clear">
                <Trash2 size={iconSize.xs} />
              </IconButton>
            }
          >
            <EmptyState
              icon={<FileText size={28} />}
              title="Plots appear here"
              hint={
                <>
                  Run a file with <Kbd>F5</Kbd> to see its output.
                </>
              }
              action={
                <Button variant="filled" tone="run">
                  Run file
                </Button>
              }
            />
          </Panel>
        </div>
      </Row>

      <Dialog
        open={dialogOpen}
        title="Delete file?"
        role="alertdialog"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="filled" tone="shell" onClick={() => setDialogOpen(false)}>
              Delete
            </Button>
          </>
        }
      >
        <p>&quot;solver.jl&quot; will be deleted permanently.</p>
      </Dialog>

      <ToastHost />
    </div>
  );
}

export const AllPrimitives: Story = { render: () => <Showcase /> };

/** The generated token values, so palette drift is visible at a glance. */
export const Palette: Story = {
  render: () => (
    <div style={{ padding: 32, background: "var(--surface-canvas)", minHeight: "100vh" }}>
      {(["dark", "light"] as const).map((name) => (
        <div key={name} style={{ marginBottom: 32 }}>
          <h3 style={{ color: "var(--fg-hi)", fontFamily: "var(--font-ui)" }}>{name}</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries({ ...palettes[name].surface, ...palettes[name].mode }).map(
              ([key, value]) => (
                <div key={key} style={{ width: 104, fontFamily: "var(--font-mono)" }}>
                  <div
                    style={{
                      height: 48,
                      background: value,
                      border: "1px solid var(--hairline)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  />
                  <div style={{ fontSize: 10, color: "var(--fg-mid)", marginTop: 4 }}>{key}</div>
                  <div style={{ fontSize: 10, color: "var(--fg-lo)" }}>{value}</div>
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  ),
};
