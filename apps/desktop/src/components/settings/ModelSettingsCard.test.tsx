import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelSettingsCard, providerId } from "./ModelSettingsCard";

describe("ModelSettingsCard", () => {
  it("offers a general OpenAI-compatible endpoint instead of only an official API key", () => {
    render(<ModelSettingsCard />);

    expect(screen.getByText("Custom endpoint")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Name — e.g. Ollama/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Base URL — Ollama/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch models" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();
  });

  it("normalizes a display name into a stable dsh provider route", () => {
    expect(providerId(" Lab DeepSeek V4 ")).toBe("custom-lab-deepseek-v4");
    expect(providerId("../../Unsafe Route")).toBe("custom-unsafe-route");
    expect(providerId("实验室模型", "https://gpu.lab.example/v1")).toBe(
      "custom-gpu-lab-example",
    );
  });
});
