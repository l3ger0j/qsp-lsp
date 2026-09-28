import { describe, it, expect } from 'vitest';
import { pickPlayerExecutable, classifyPlayerPath } from '../src/common/playerExecutable';

describe('pickPlayerExecutable', () => {
  it('takes a plain path on every platform, trimmed', () => {
    expect(pickPlayerExecutable('  tools/qspgui.exe ', 'win32')).toBe('tools/qspgui.exe');
    expect(pickPlayerExecutable('tools/qspgui.exe', 'linux')).toBe('tools/qspgui.exe');
  });

  it('takes the entry for the current platform from an object', () => {
    const value = { win32: 'C:\\QSP\\qspgui.exe', linux: '/usr/bin/qspgui' };
    expect(pickPlayerExecutable(value, 'win32')).toBe('C:\\QSP\\qspgui.exe');
    expect(pickPlayerExecutable(value, 'linux')).toBe('/usr/bin/qspgui');
  });

  it('returns undefined so the caller falls back to the setting', () => {
    expect(pickPlayerExecutable({ win32: 'qspgui.exe' }, 'darwin')).toBeUndefined();
    expect(pickPlayerExecutable(undefined, 'linux')).toBeUndefined();
    expect(pickPlayerExecutable('   ', 'linux')).toBeUndefined();
    expect(pickPlayerExecutable(42, 'linux')).toBeUndefined();
    expect(pickPlayerExecutable(['qspgui'], 'linux')).toBeUndefined();
    expect(pickPlayerExecutable({ linux: 7 }, 'linux')).toBeUndefined();
  });
});

describe('classifyPlayerPath', () => {
  it('recognises absolute POSIX, Windows drive and UNC paths', () => {
    expect(classifyPlayerPath('/usr/bin/qspgui')).toBe('absolute');
    expect(classifyPlayerPath('C:\\QSP\\qspgui.exe')).toBe('absolute');
    expect(classifyPlayerPath('d:/qsp/qspgui.exe')).toBe('absolute');
    expect(classifyPlayerPath('\\\\server\\share\\qspgui.exe')).toBe('absolute');
  });

  it('treats a bare name as a command looked up on PATH', () => {
    expect(classifyPlayerPath('qspgui')).toBe('command');
    expect(classifyPlayerPath('qspgui.exe')).toBe('command');
  });

  it('treats a path with a separator as relative to the workspace', () => {
    expect(classifyPlayerPath('tools/qspgui.exe')).toBe('relative');
    expect(classifyPlayerPath('./qspgui')).toBe('relative');
    expect(classifyPlayerPath('..\\player\\qspgui.exe')).toBe('relative');
    expect(classifyPlayerPath('плеер/qspgui')).toBe('relative');
  });
});
