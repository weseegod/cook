import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `globals` is off, so Testing Library's auto-cleanup never registers and each test would render
// into a document that still holds every earlier test's markup.
afterEach(cleanup);
