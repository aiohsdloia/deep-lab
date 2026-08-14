import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RefObject } from "react";
import { BlockList } from "./BlockList";
import { useRuntimeStore } from "@/lib/runtime";

// The virtualized list measures visibility against the thread's scroll
// container; jsdom reports zero layout, so stub a non-zero viewport so the
// initial (and overscanned) rows actually render.
function scrollRef(): RefObject<HTMLDivElement> {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 800, bottom: 800, width: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  for (const key of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight"] as const) {
    Object.defineProperty(el, key, { configurable: true, value: 800 });
  }
  return { current: el };
}

// A running task row surfaces its subagent's latest step. The activity is no
// longer threaded through props — the row self-subscribes to the child thread in
// the store (SubagentActivity), so these tests seed that thread directly (#34).
describe("BlockList", () => {
  afterEach(() => {
    useRuntimeStore.setState({ threads: {} });
  });

  it("shows a running task row the live activity of its subagent", () => {
    useRuntimeStore.setState({
      threads: {
        ses_child: {
          blocks: [{ kind: "tool-call", title: "python3 analyze slide-03.jpg", status: "running" }],
          index: {},
          loaded: true,
        },
      },
    });
    render(
      <BlockList
        blocks={[
          { kind: "tool-call", title: "Visual QA for slides", status: "running", childSessionId: "ses_child" },
        ]}
        scrollElementRef={scrollRef()}
      />,
    );
    expect(screen.getByText("python3 analyze slide-03.jpg")).toBeInTheDocument();
  });

  it("renders a row that spawned no subagent without any activity line", () => {
    render(
      <BlockList
        blocks={[{ kind: "tool-call", title: "ls -la", status: "running" }]}
        scrollElementRef={scrollRef()}
      />,
    );
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(document.querySelector("[data-subagent-activity]")).toBeNull();
  });
});
