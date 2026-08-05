import type { Meta, StoryObj } from "@storybook/react";
import { StatusBar } from "./StatusBar";
import { useIdeStore } from "../../stores/useIdeStore";

const meta: Meta<typeof StatusBar> = {
  title: "Components/StatusBar",
  component: StatusBar,
  decorators: [
    (Story) => (
      <div style={{ width: "100%", position: "fixed", bottom: 0, left: 0 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof StatusBar>;

export const Default: Story = {
  name: "Default (idle)",
};

export const Running: Story = {
  name: "Julia running",
  play: () => {
    useIdeStore.setState({ isRunning: true, juliaVersion: "Julia 1.10.4" });
  },
};

export const Debugging: Story = {
  name: "Debugging",
  play: () => {
    useIdeStore.setState({
      debug: {
        isDebugging: true,
        isPaused: true,
        currentFile: "/test.jl",
        currentLine: 5,
        variables: [],
        callStack: ["main"],
      },
    });
  },
};

export const LspReady: Story = {
  name: "LSP ready",
  play: () => {
    useIdeStore.setState({ lspStatus: "ready", juliaVersion: "Julia 1.10.4" });
  },
};

export const LspStarting: Story = {
  name: "LSP starting",
  play: () => {
    useIdeStore.setState({ lspStatus: "starting", juliaVersion: "Julia 1.10.4" });
  },
};

export const LspError: Story = {
  name: "LSP error",
  play: () => {
    useIdeStore.setState({
      lspStatus: "error",
      lspErrorMessage: "LanguageServer.jl failed to start",
      juliaVersion: "Julia 1.10.4",
    });
  },
};

export const WithRevise: Story = {
  name: "Revise enabled",
  play: () => {
    useIdeStore.setState({ reviseEnabled: true, lspStatus: "ready", juliaVersion: "Julia 1.10.4" });
  },
};

export const PlutoReady: Story = {
  name: "Pluto running",
  play: () => {
    useIdeStore.setState({
      plutoStatus: "ready",
      plutoMessage: "http://localhost:3000",
      juliaVersion: "Julia 1.10.4",
    });
  },
};

export const WithOpenFile: Story = {
  name: "File open",
  play: () => {
    useIdeStore.setState({
      juliaVersion: "Julia 1.10.4",
      lspStatus: "ready",
      openTabs: [
        {
          id: "tab-1",
          path: "/project/main.jl",
          name: "main.jl",
          content: "",
          isDirty: false,
          language: "julia",
        },
      ],
      activeTabId: "tab-1",
    });
  },
};
