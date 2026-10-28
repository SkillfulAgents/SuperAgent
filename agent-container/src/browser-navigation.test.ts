import { describe, expect, it, vi } from 'vitest';
import { createBrowserNavigation } from './browser-navigation';

const entries = [
  { id: 10, url: 'https://a.test/' },
  { id: 20, url: 'https://b.test/' },
  { id: 30, url: 'https://c.test/' },
];

function setup() {
  let id = 0;
  const commands: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  const publish = vi.fn();
  const navigation = createBrowserNavigation({
    targetId: 'tab-a', publish,
    sendCommand(method, params) {
      commands.push({ id: ++id, method, params });
      return id;
    },
  });
  const reply = (currentIndex: number, requestId = id) => navigation.handleMessage({ id: requestId, result: { entries, currentIndex } });
  return { navigation, commands, publish, reply };
}

describe('browser navigation', () => {
  it('reports the new document at commit even when resources never finish loading', () => {
    const { navigation, publish, reply, commands } = setup();
    navigation.refresh();
    reply(0);
    navigation.handleMessage({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } });
    expect(commands.at(-1)?.method).toBe('Page.getNavigationHistory');
    reply(1);
    expect(publish).toHaveBeenLastCalledWith({
      type: 'history_state', targetId: 'tab-a', url: 'https://b.test/', canGoBack: true, canGoForward: true,
    });
  });

  it('coalesces lifecycle events and discards the reply from before a document change', () => {
    const { navigation, publish, commands, reply } = setup();
    navigation.refresh();
    navigation.handleMessage({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } });
    navigation.handleMessage({ method: 'Page.navigatedWithinDocument', params: { frameId: 'main' } });
    navigation.handleMessage({ method: 'Page.frameStoppedLoading', params: { frameId: 'main' } });
    expect(commands).toHaveLength(1);
    reply(0, 1);
    expect(publish).not.toHaveBeenCalled();
    expect(commands).toHaveLength(2);
    reply(2);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].url).toBe('https://c.test/');
  });

  it('does not republish unchanged history when iframes replace their URL', () => {
    const { navigation, publish, reply } = setup();
    navigation.refresh();
    reply(1);
    for (let i = 0; i < 10; i++) {
      navigation.handleMessage({ method: 'Page.navigatedWithinDocument', params: { frameId: 'child' } });
      reply(1);
    }
    expect(publish).toHaveBeenCalledOnce();
  });

  it('publishes useful history even when iframe updates arrive before every reply', () => {
    const { navigation, commands, publish, reply } = setup();
    navigation.handleMessage({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } });
    for (let cycle = 0; cycle < 3; cycle++) {
      const requestId = commands.at(-1)!.id;
      for (let event = 0; event < 10; event++) {
        navigation.handleMessage({ method: 'Page.navigatedWithinDocument', params: { frameId: 'child' } });
      }
      reply(1, requestId);
      expect(publish).toHaveBeenLastCalledWith({
        type: 'history_state', targetId: 'tab-a', url: 'https://b.test/', canGoBack: true, canGoForward: true,
      });
    }
    expect(commands).toHaveLength(4);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('ignores subframe loads and tracks the main frame across commits', () => {
    const { navigation, commands } = setup();
    navigation.handleMessage({ result: { frameTree: { frame: { id: 'main' } } } });
    navigation.handleMessage({ method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'main' } } });
    navigation.handleMessage({ method: 'Page.frameStoppedLoading', params: { frameId: 'child' } });
    expect(commands).toHaveLength(0);
    navigation.handleMessage({ method: 'Page.frameNavigated', params: { frame: { id: 'new-main' } } });
    expect(navigation.isMainFrame('new-main')).toBe(true);
    expect(navigation.isMainFrame('main')).toBe(false);
    expect(commands).toHaveLength(1);
  });

  it('steps to adjacent history entries and reloads without a history query', () => {
    const { navigation, commands, reply } = setup();
    navigation.navigate('back');
    reply(1);
    expect(commands.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 10 } });
    navigation.navigate('forward');
    reply(1);
    expect(commands.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 30 } });
    navigation.navigate('reload');
    expect(commands.at(-1)?.method).toBe('Page.reload');
    expect(commands).toHaveLength(5);
  });

  it('does not navigate outside history and recovers after a failed query', () => {
    const { navigation, commands, reply, publish } = setup();
    navigation.navigate('back');
    reply(0);
    navigation.navigate('forward');
    reply(2);
    expect(commands).toHaveLength(2);
    navigation.refresh();
    expect(navigation.handleMessage({ id: 3 })).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    navigation.refresh();
    reply(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('leaves unrelated CDP replies alone and discards replies after detaching', () => {
    const { navigation, commands, publish, reply } = setup();
    navigation.refresh();
    expect(navigation.handleMessage({ id: 99 })).toBe(false);
    navigation.dispose();
    reply(1);
    navigation.navigate('reload');
    navigation.refresh();
    expect(publish).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
  });
});
