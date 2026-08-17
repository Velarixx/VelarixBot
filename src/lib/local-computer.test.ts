import { describe, expect, it } from "vitest";

import {
  localAutoHint,
  localComputerLabel,
  localComputerModes,
  localComputerNoun,
  localComputerSupported,
  localUnavailableCopy,
} from "./local-computer";

describe("local computer UI gate", () => {
  it("shows This Mac on darwin and in the browser, This PC on win32", () => {
    expect(localComputerSupported("darwin")).toBe(true);
    expect(localComputerSupported("win32")).toBe(true);
    expect(localComputerSupported(undefined)).toBe(true);
    expect(localComputerLabel("darwin")).toBe("This Mac");
    expect(localComputerLabel(undefined)).toBe("This Mac");
    expect(localComputerLabel("win32")).toBe("This PC");
    expect(localComputerNoun("win32")).toBe("this PC");
    expect(localComputerModes("win32")).toEqual([["local", "This PC"]]);
    expect(localComputerModes("darwin")).toEqual([["local", "This Mac"]]);
  });

  it("hides local on linux and never claims it is supported", () => {
    expect(localComputerSupported("linux")).toBe(false);
    expect(localComputerModes("linux")).toEqual([]);
    expect(localAutoHint("linux")).toMatch(/else Off/);
    expect(localUnavailableCopy("linux", true)).toMatch(/Linux/);
    expect(localUnavailableCopy("linux", true)).not.toMatch(/This PC|This Mac/);
  });

  it("browser without Electron still asks for the desktop app", () => {
    expect(localUnavailableCopy("win32", false)).toMatch(/desktop app/);
    expect(localAutoHint("win32")).toMatch(/this PC/);
    expect(localAutoHint("darwin")).toMatch(/this Mac/);
  });
});
