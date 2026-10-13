/**
 * Regression tests for https://github.com/Mintplex-Labs/anythingllm-mobile/issues/129
 *
 * Leaving a thread while its reply is still streaming used to lose the whole exchange: the
 * screen unmounts, aborts the generation and the unfinished chat was discarded without ever
 * being saved, so returning to the thread showed nothing. The handler now preserves the
 * partial exchange when the screen goes away, while an explicit stop still discards it.
 */
jest.mock('@/store/UIStore', () => ({
  __esModule: true,
  default: {
    emitter: { emit: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) },
    globalEvents: {
      MODEL_DOWNLOAD_STARTED: 'model_download_started',
      MODEL_DOWNLOAD_COMPLETE: 'model_download_complete',
      WORKSPACE_REATTACH_REQUESTED: 'workspace_reattach_requested',
      ONBOARDING_COMPLETED: 'onboarding_completed',
    },
    session: new Map(),
  },
}));
jest.mock('@/database/models/WorkspaceChat', () => ({
  __esModule: true,
  default: {
    newChatItem: jest.fn((data: any) => ({
      uuid: 'chat-uuid-1',
      workspaceThreadSlug: data.workspaceThreadSlug,
      prompt: data.prompt,
      response: {
        textResponse: '',
        thoughts: [],
        toolCalls: [],
        actions: [],
        metrics: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, outputTps: 0, duration: 0 },
        attachments: [],
        citations: [],
        activity: [],
      },
      createdAt: 1,
      isLoading: true,
    })),
    create: jest.fn(async (data: any) => data),
    find: jest.fn(async () => []),
    delete: jest.fn(async () => true),
  },
}));
jest.mock('@/database/models/WorkspaceThread', () => ({
  __esModule: true,
  default: {
    autoRename: jest.fn(async () => undefined),
    linkRemote: jest.fn(async () => 'remote-thread'),
  },
}));
jest.mock('@/utils/AiProviders/delegatedProvider', () => ({
  __esModule: true,
  default: class {
    static validateConfig = jest.fn(async () => false);
    static sendCommand = jest.fn(async () => ({}));
    streamChat = jest.fn(async () => undefined);
  },
}));
jest.mock('@/utils/keepAwake', () => ({ activateKeepAwake: jest.fn(), deactivateKeepAwake: jest.fn() }));
jest.mock('@/utils/Telemetry', () => ({
  __esModule: true,
  default: {
    logEvent: jest.fn(),
    CUSTOM_EVENTS: { ACTIONS: { CHAT_COMPLETED: 'chat_completed', CHAT_ABORTED: 'chat_aborted', CHAT_RETRIED: 'chat_retried' } },
  },
}));
jest.mock('@/utils/PushNotifications', () => ({
  __esModule: true,
  default: { notifyChatComplete: jest.fn(), promptToEnableForChat: jest.fn(async () => undefined) },
}));
jest.mock('@/utils/models/lowMemory', () => ({
  claimLowMemoryWarning: jest.fn(async () => null),
}));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('@/utils/constants', () => ({ generateUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
jest.mock('@/components/LowMemoryModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/AwaitableAlert', () => ({ __esModule: true, default: jest.fn(async () => true) }));
jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getSystemName: () => 'Android',
    getSystemVersion: () => '15',
    getApiLevelSync: () => 35,
    getModel: () => 'test-device',
    getTotalMemorySync: () => 8 * 1024 * 1024 * 1024,
    getUsedMemorySync: () => 4 * 1024 * 1024 * 1024,
    getBrand: () => 'test',
    getDeviceId: () => 'test-device-id',
  },
}));

import TestRenderer, { act } from 'react-test-renderer';
import WorkspaceChat from '@/database/models/WorkspaceChat';
import {
  ChatHandlerWrapper,
  useChatHandlerContext,
  useChatHistoryContext,
  type ChatHandlerInterface,
} from '@/hooks/useChatHandler';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const STREAMED_TEXT = 'The capital of France is Par';

let probe: ChatHandlerInterface | null = null;
function Probe() {
  probe = useChatHandlerContext();
  useChatHistoryContext();
  return null;
}

const workspace = { slug: 'ws-1', name: 'Workspace', isRemote: false, remoteConfig: null } as any;
const thread = { slug: 'th-1', name: 'Thread', isRemote: false, remoteConfig: { slug: null } } as any;

/**
 * Provider double that streams one chunk and then waits for its abort signal, the way every
 * real provider behaves: it only stops when the handler aborts it.
 */
function makeProvider() {
  let signal: AbortSignal | null = null;
  return {
    name: 'test-provider',
    model: 'test-model',
    attachAbortSignal: jest.fn((next: AbortSignal | null) => { signal = next; }),
    attachWorkspaceToProvider: jest.fn(),
    chat: jest.fn((args: any) => new Promise((_resolve, reject) => {
      args.onStream('chunk', STREAMED_TEXT);
      if (signal?.aborted) return reject(new Error('Chat aborted by user'));
      signal?.addEventListener('abort', () => reject(new Error('Chat aborted by user')), { once: true });
    })),
  } as any;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The public interface types `submitPrompt` as `void`, but it is an async function that only
 * resolves once the turn has settled (abort handling included) - the tests need to await that.
 */
const startSubmission = (text: string): Promise<void> =>
  probe!.submitPrompt(text) as unknown as Promise<void>;

describe('leaving a thread mid-reply (issue #129)', () => {
  beforeEach(() => {
    probe = null;
    (WorkspaceChat.create as jest.Mock).mockClear();
    (WorkspaceChat.newChatItem as jest.Mock).mockClear();
  });

  test('saves the partial exchange instead of losing it when the screen unmounts', async () => {
    const provider = makeProvider();
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <ChatHandlerWrapper workspace={workspace} thread={thread} llmProvider={provider}>
          <Probe />
        </ChatHandlerWrapper>
      );
    });
    expect(probe).not.toBeNull();

    let submission: Promise<void> | undefined;
    await act(async () => {
      submission = startSubmission('What is the capital of France?');
      for (let i = 0; i < 5; i++) await flush();
    });
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(WorkspaceChat.create).not.toHaveBeenCalled();

    // The user switches threads: the screen unmounts while the reply is still streaming.
    // The unmount must be flushed by act before awaiting the turn - awaiting inside the act
    // callback would deadlock (the abort that settles the turn IS the effect cleanup act still
    // has to run).
    await act(async () => {
      tree!.unmount();
    });
    await submission;
    await flush();

    // The question and the streamed text were preserved...
    expect(WorkspaceChat.create).toHaveBeenCalledTimes(1);
    const saved = (WorkspaceChat.create as jest.Mock).mock.calls[0][0];
    expect(saved.uuid).toBe('chat-uuid-1');
    expect(saved.workspaceThreadSlug).toBe('th-1');
    expect(saved.prompt).toBe('What is the capital of France?');
    expect(saved.response.textResponse).toBe(STREAMED_TEXT);
    expect(saved.isLoading).toBe(false);
  });

  test('still discards the exchange when the user stops the reply on purpose', async () => {
    const provider = makeProvider();
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <ChatHandlerWrapper workspace={workspace} thread={thread} llmProvider={provider}>
          <Probe />
        </ChatHandlerWrapper>
      );
    });
    expect(probe).not.toBeNull();

    let submission: Promise<void> | undefined;
    await act(async () => {
      submission = startSubmission('What is the capital of France?');
      for (let i = 0; i < 5; i++) await flush();
    });
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // Stop button: the reply is thrown away, nothing is saved even once the screen goes away.
    await act(async () => {
      probe!.abortChat();
    });
    await submission;
    await act(async () => {
      tree!.unmount();
    });
    await flush();

    expect(WorkspaceChat.create).not.toHaveBeenCalled();
  });
});

