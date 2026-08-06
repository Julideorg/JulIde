import type { Meta, StoryObj } from "@storybook/react";
import { ActivityBar } from "./ActivityBar";
import { usePluginStore } from "../../stores/usePluginStore";
import { useIdeStore } from "../../stores/useIdeStore";

const meta: Meta<typeof ActivityBar> = {
  title: "Components/ActivityBar",
  component: ActivityBar,
  decorators: [
    (Story) => {
      // Register built-in sidebar panels for the story
      const store = usePluginStore.getState();
      store.registerSidebarPanel({ id: "files", label: "Explorer", icon: "Files", order: 1 });
      store.registerSidebarPanel({ id: "search", label: "Search", icon: "Search", order: 2 });
      store.registerSidebarPanel({
        id: "git",
        label: "Source Control",
        icon: "GitBranch",
        order: 3,
      });
      store.registerSidebarPanel({
        id: "containers",
        label: "Containers",
        icon: "Container",
        order: 4,
      });
      return (
        <div style={{ height: "400px", background: "var(--surface-chrome)" }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ActivityBar>;

export const Default: Story = {
  name: "Default (Files active)",
  play: () => {
    useIdeStore.setState({ activeSidebarView: "files" });
  },
};

export const SearchActive: Story = {
  name: "Search active",
  play: () => {
    useIdeStore.setState({ activeSidebarView: "search" });
  },
};

export const GitActive: Story = {
  name: "Source Control active",
  play: () => {
    useIdeStore.setState({ activeSidebarView: "git" });
  },
};
