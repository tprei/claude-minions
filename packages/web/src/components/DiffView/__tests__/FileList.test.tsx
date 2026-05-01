import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DiffStat } from "../../../types.js";
import { FileList } from "../FileList.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

function rows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="diffview-file-row"]'),
  );
}

const FILES: DiffStat[] = [
  { path: "src/a.ts", additions: 5, deletions: 2, status: "added" },
  { path: "src/b.ts", additions: 1, deletions: 4, status: "modified" },
  { path: "src/c.ts", additions: 0, deletions: 9, status: "deleted" },
  {
    path: "src/new.ts",
    additions: 3,
    deletions: 1,
    status: "renamed",
    oldPath: "src/old.ts",
  },
  { path: "src/d.ts", additions: 7, deletions: 0, status: "untracked" },
];

describe("FileList", () => {
  it("renders one row per file with correct +/- counts", () => {
    act(() => {
      root.render(
        createElement(FileList, { files: FILES, selectedPath: null, onSelect: () => {} }),
      );
    });
    const items = rows();
    expect(items).toHaveLength(FILES.length);
    for (let i = 0; i < FILES.length; i++) {
      const file = FILES[i]!;
      const row = items[i]!;
      expect(row.dataset["path"]).toBe(file.path);
      expect(row.textContent).toContain(`+${file.additions}`);
      expect(row.textContent).toContain(`-${file.deletions}`);
    }
  });

  it("renders the correct status badge for each status", () => {
    act(() => {
      root.render(
        createElement(FileList, { files: FILES, selectedPath: null, onSelect: () => {} }),
      );
    });
    const items = rows();
    const expected = ["A", "M", "D", "R", "U"];
    for (let i = 0; i < expected.length; i++) {
      const firstSpan = items[i]!.querySelector("span");
      expect(firstSpan?.textContent).toBe(expected[i]);
    }
  });

  it("invokes onSelect with the row path on click", () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        createElement(FileList, { files: FILES, selectedPath: null, onSelect }),
      );
    });
    act(() => {
      rows()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("src/c.ts");
  });

  it("renders renamed files as oldPath → path", () => {
    act(() => {
      root.render(
        createElement(FileList, { files: FILES, selectedPath: null, onSelect: () => {} }),
      );
    });
    const renamed = rows().find((r) => r.dataset["path"] === "src/new.ts");
    expect(renamed?.textContent).toContain("src/old.ts → src/new.ts");
  });

  it("applies the active class to the row whose path matches selectedPath", () => {
    act(() => {
      root.render(
        createElement(FileList, {
          files: FILES,
          selectedPath: "src/b.ts",
          onSelect: () => {},
        }),
      );
    });
    const items = rows();
    expect(items[0]!.classList.contains("bg-bg-elev")).toBe(false);
    expect(items[1]!.classList.contains("bg-bg-elev")).toBe(true);
    expect(items[2]!.classList.contains("bg-bg-elev")).toBe(false);
  });

  it("shows total count and aggregate +/- in the sticky header", () => {
    act(() => {
      root.render(
        createElement(FileList, { files: FILES, selectedPath: null, onSelect: () => {} }),
      );
    });
    const totalAdds = FILES.reduce((acc, f) => acc + f.additions, 0);
    const totalDels = FILES.reduce((acc, f) => acc + f.deletions, 0);
    const header = container.querySelector(".sticky");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain(`${FILES.length} files`);
    expect(header?.textContent).toContain(`+${totalAdds}`);
    expect(header?.textContent).toContain(`-${totalDels}`);
  });

  it("uses singular 'file' in the header for a single file", () => {
    act(() => {
      root.render(
        createElement(FileList, {
          files: [FILES[0]!],
          selectedPath: null,
          onSelect: () => {},
        }),
      );
    });
    const header = container.querySelector(".sticky");
    expect(header?.textContent).toContain("1 file");
  });
});
