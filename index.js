import { highlightInChat } from './highlight.js';
import { getGroupPastChats } from '../../../group-chats.js';
import { getPastCharacterChats, animation_duration, animation_easing, getGeneratingApi } from '../../../../script.js';
import { debounce, timestampToMoment, sortMoments, uuidv4, waitUntilCondition } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { t } from '../../../i18n.js';

const {
    eventSource,
    event_types,
    getCurrentChatId,
    renameChat,
    openGroupChat,
    openCharacterChat,
    executeSlashCommandsWithOptions,
    Popup,
    POPUP_RESULT,
} = SillyTavern.getContext();

/** @type {HTMLDivElement} */
const movingDivs = document.getElementById('movingDivs');
/** @type {HTMLDivElement} */
const sheld = document.getElementById('sheld');
/** @type {HTMLDivElement} */
const chat = document.getElementById('chat');
/** @type {HTMLTemplateElement} */
const draggableTemplate = document.getElementById('generic_draggable_template');
/** @type {HTMLDivElement} */
const apiBlock = document.getElementById('rm_api_block');

const topBar = document.createElement('div');
const chatName = document.createElement('select');
const searchInput = document.createElement('input');
const connectionProfiles = document.createElement('div');
const connectionProfilesStatus = document.createElement('div');
const connectionProfilesSelect = document.createElement('select');
const connectionProfilesIcon = document.createElement('img');
const connectionPresetSelect = document.createElement('select');

/**
 * SillyTavern preset selectors per main API. The top bar generation preset
 * dropdown mirrors whichever of these belongs to the currently selected API.
 * @type {Record<string, string>}
 */
const generationPresetSelectors = {
    kobold: '#settings_preset',
    koboldhorde: '#settings_preset',
    novel: '#settings_preset_novel',
    openai: '#settings_preset_openai',
    textgenerationwebui: '#settings_preset_textgenerationwebui',
};

/** @type {HTMLSelectElement?} */
let observedPresetSelect = null;
/** @type {MutationObserver?} */
let presetSelectObserver = null;
/** @type {(() => void)?} */
let presetSelectChangeHandler = null;

/**
 * Matches the media query ST uses for its compact/mobile layout.
 * @type {MediaQueryList}
 */
const mobileLayout = window.matchMedia('(max-width: 1000px)');

/**
 * Toolbar buttons, left to right. `isTemporaryAllowed` buttons stay usable
 * when no chat is open (welcome screen and temporary chats).
 */
const icons = [
    {
        id: 'extensionTopBarToggleSidebar',
        icon: 'fa-fw fa-solid fa-box-archive',
        position: 'left',
        title: t`Toggle sidebar`,
        onClick: onToggleSidebarClick,
    },
    {
        id: 'extensionTopBarToggleConnectionProfiles',
        icon: 'fa-fw fa-solid fa-plug',
        position: 'left',
        title: t`Show connection profiles`,
        isTemporaryAllowed: true,
        onClick: onToggleConnectionProfilesClick,
    },
    {
        id: 'extensionTopBarChatManager',
        icon: 'fa-fw fa-solid fa-address-book',
        position: 'right',
        title: t`View chat files`,
        isTemporaryAllowed: true,
        onClick: onChatManagerClick,
    },
    {
        id: 'extensionTopBarNewChat',
        icon: 'fa-fw fa-solid fa-comments',
        position: 'right',
        title: t`New chat`,
        isTemporaryAllowed: true,
        onClick: onNewChatClick,
    },
    {
        id: 'extensionTopBarRenameChat',
        icon: 'fa-fw fa-solid fa-edit',
        position: 'right',
        title: t`Rename chat`,
        onClick: onRenameChatClick,
    },
    {
        id: 'extensionTopBarDeleteChat',
        icon: 'fa-fw fa-solid fa-trash',
        position: 'right',
        title: t`Delete chat`,
        onClick: onDeleteChatClick,
    },
    {
        id: 'extensionTopBarCloseChat',
        icon: 'fa-fw fa-solid fa-times',
        position: 'right',
        title: t`Close chat`,
        isTemporaryAllowed: true,
        onClick: onCloseChatClick,
    },
];

function onChatManagerClick() {
    // Let SillyTavern show its own toast if the command fails instead of throwing
    // an unhandled rejection (handleExecutionErrors defaults to false).
    void executeSlashCommandsWithOptions('/chat-manager', { handleExecutionErrors: true });
}

function onNewChatClick() {
    document.getElementById('option_start_new_chat')?.click();
}

function onCloseChatClick() {
    // Runs the same code path as SillyTavern's own "Close chat" entry and also
    // works for cardless/temporary chats (see Extension-TopInfoBar#7).
    void executeSlashCommandsWithOptions('/closechat', { handleExecutionErrors: true });
}

async function onDeleteChatClick() {
    const result = await Popup.show.confirm(t`Delete chat`, t`Are you sure you want to delete the current chat?`);

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    await executeSlashCommandsWithOptions('/delchat', { handleExecutionErrors: true });
}

async function onRenameChatClick() {
    const currentChatName = getCurrentChatId();

    if (!currentChatName) {
        return;
    }

    const newChatName = await Popup.show.input(t`Enter new chat name`, null, currentChatName);

    if (!newChatName || newChatName === currentChatName) {
        return;
    }

    await renameChat(currentChatName, String(newChatName));
}

/**
 * ST's `#sheld` is a flex container since early 2024. Very old builds used a grid
 * layout, which needs this shim to keep the top bar above the chat. Harmless on
 * current builds (the computed display is already `flex`).
 */
function patchSheldIfNeeded() {
    if (!sheld) {
        console.warn('Sheld not found. Did it get renamed?');
        return;
    }

    const computedStyle = getComputedStyle(sheld);
    if (computedStyle.display === 'grid') {
        sheld.classList.add('flexPatch');
    }
}

/**
 * Fills the chat name selector and toggles the "no chat open" state of the toolbar.
 * @param {string} name Name of the currently opened chat
 */
function setChatName(name) {
    const isNotInChat = !name;
    chatName.innerHTML = '';
    const selectedOption = document.createElement('option');
    selectedOption.innerText = name || t`No chat selected`;
    selectedOption.selected = true;
    chatName.appendChild(selectedOption);
    chatName.disabled = true;

    for (const icon of icons) {
        const iconElement = document.getElementById(icon.id);
        if (iconElement && !icon.isTemporaryAllowed) {
            iconElement.classList.toggle('not-in-chat', isNotInChat);
        }
    }

    setTimeout(async () => {
        try {
            const chats = isNotInChat ? [] : await getChatFiles();

            if (!isNotInChat) {
                populateChatNameSelect(chats, name);
            }

            await populateSideBar(chats);
        } catch (error) {
            console.error('Failed to refresh the top bar chat list', error);
        }
    }, 0);
}

/**
 * Rebuilds the list of every chat of the current character/group in the selector.
 * @param {Array<object|string>} chats Chat entries of {@link getChatFiles}
 * @param {string} selectedName Name of the chat that should be selected
 */
function populateChatNameSelect(chats, selectedName) {
    const chatNames = chats
        .map(entry => (typeof entry === 'string' ? entry : entry?.file_name))
        .filter(Boolean)
        .map(fileName => String(fileName).replace('.jsonl', ''));

    if (chatNames.length === 0) {
        return;
    }

    chatName.innerHTML = '';
    chatNames.sort((a, b) => a.localeCompare(b)).forEach(name => {
        const option = document.createElement('option');
        option.innerText = name;
        option.value = name;
        option.selected = name === selectedName;

        chatName.appendChild(option);
    });
    chatName.disabled = false;
}

/**
 * Returns the chat list of the current character or group.
 * @returns {Promise<Array<object|string>>} List of chat entries
 */
async function getChatFiles() {
    const context = SillyTavern.getContext();

    if (!getCurrentChatId()) {
        return [];
    }

    if (context.groupId) {
        return await getGroupPastChats(context.groupId);
    }

    if (context.characterId !== undefined) {
        return await getPastCharacterChats(context.characterId);
    }

    return [];
}

const searchDebounced = debounce(query => highlightInChat(chat, query), 500);
const updateStatusDebounced = debounce(onOnlineStatusChange, 1000);

/**
 * Prevents the toolbar from leaking gestures into the chat swipe/scroll handlers
 * on touch devices while leaving native scrolling of the bar itself intact.
 */
function isolateTopBarGestures() {
    const gestureEvents = [
        'touchstart', 'touchmove', 'touchend', 'touchcancel',
        'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
        'wheel',
    ];

    for (const eventName of gestureEvents) {
        topBar.addEventListener(eventName, event => {
            if (mobileLayout.matches) {
                event.stopPropagation();
            }
        }, { passive: true });
    }
}

function addTopBar() {
    chatName.id = 'extensionTopBarChatName';
    topBar.id = 'extensionTopBar';
    searchInput.id = 'extensionTopBarSearchInput';
    searchInput.placeholder = t`Search...`;
    searchInput.setAttribute('aria-label', t`Search in chat`);
    searchInput.classList.add('text_pole');
    searchInput.type = 'search';
    searchInput.addEventListener('input', () => searchDebounced(searchInput.value.trim()));
    isolateTopBarGestures();
    topBar.append(chatName, searchInput);
    sheld.insertBefore(topBar, chat);
}

function addIcons() {
    for (const icon of icons) {
        const iconElement = document.createElement('i');
        iconElement.id = icon.id;
        iconElement.className = icon.icon;
        iconElement.title = icon.title;
        iconElement.setAttribute('role', 'button');
        iconElement.setAttribute('aria-label', icon.title);
        iconElement.tabIndex = 0;
        iconElement.classList.add('right_menu_button');

        if (icon.id === 'extensionTopBarRenameChat' && typeof renameChat !== 'function') {
            iconElement.classList.add('displayNone');
        }

        const activate = () => {
            if (iconElement.classList.contains('not-in-chat')) {
                return;
            }
            void icon.onClick();
        };

        iconElement.addEventListener('click', activate);
        iconElement.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });

        if (icon.position === 'left') {
            topBar.insertBefore(iconElement, chatName);
            continue;
        }

        if (icon.position === 'middle') {
            topBar.insertBefore(iconElement, searchInput);
            continue;
        }

        topBar.appendChild(iconElement);
    }
}

function addSideBar() {
    if (!draggableTemplate) {
        console.warn(t`Draggable template not found. Side bar will not be added.`);
        return;
    }

    const fragment = /** @type {DocumentFragment} */ (draggableTemplate.content.cloneNode(true));
    const draggable = fragment.querySelector('.draggable');
    const closeButton = fragment.querySelector('.dragClose');

    if (!draggable || !closeButton) {
        console.warn(t`Failed to find draggable or close button. Side bar will not be added.`);
        return;
    }

    draggable.id = 'extensionSideBar';
    closeButton.addEventListener('click', onToggleSidebarClick);

    const scrollContainer = document.createElement('div');
    scrollContainer.id = 'extensionSideBarContainer';
    draggable.appendChild(scrollContainer);

    const loaderContainer = document.createElement('div');
    loaderContainer.id = 'extensionSideBarLoader';
    draggable.appendChild(loaderContainer);

    const loaderIcon = document.createElement('i');
    loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
    loaderContainer.appendChild(loaderIcon);

    movingDivs.appendChild(draggable);
}

function addConnectionProfiles() {
    connectionProfiles.id = 'extensionConnectionProfiles';
    connectionProfilesStatus.id = 'extensionConnectionProfilesStatus';
    connectionProfilesSelect.id = 'extensionConnectionProfilesSelect';
    connectionProfilesSelect.title = t`Switch connection profile`;
    connectionProfilesSelect.setAttribute('aria-label', t`Switch connection profile`);
    connectionPresetSelect.id = 'extensionConnectionPresetSelect';
    connectionPresetSelect.title = t`Switch generation preset`;
    connectionPresetSelect.setAttribute('aria-label', t`Switch generation preset`);

    const connectionProfilesServerIcon = document.createElement('i');
    connectionProfilesServerIcon.id = 'extensionConnectionProfilesIcon';
    connectionProfilesServerIcon.className = 'fa-fw fa-solid fa-network-wired';

    connectionProfiles.append(connectionProfilesServerIcon, connectionProfilesSelect, connectionPresetSelect, connectionProfilesStatus, connectionProfilesIcon);
    sheld.insertBefore(connectionProfiles, chat);

    apiBlock?.querySelectorAll('select').forEach(select => {
        select.addEventListener('input', () => updateStatusDebounced());
    });
}

/**
 * Mirrors ST's connection profile selector into the top bar panel.
 * The selector lives in the built-in "Connection Profiles" extension, so it can
 * legitimately be missing (extension disabled, late settings render, custom UI).
 */
/**
 * Returns the preset <select> SillyTavern uses for the currently active main API.
 * @returns {HTMLSelectElement?}
 */
function getActiveGenerationPresetSelect() {
    const context = SillyTavern.getContext();
    const mainApi = context.mainApi ?? document.getElementById('main_api')?.value;
    const selector = generationPresetSelectors[mainApi];

    if (!selector) {
        return null;
    }

    const presetSelect = document.querySelector(selector);
    return presetSelect instanceof HTMLSelectElement ? presetSelect : null;
}

/**
 * Keeps observer and change listener attached to the preset select of the active API.
 * @param {HTMLSelectElement?} presetSelect Active SillyTavern preset select, if any
 */
function observeActiveGenerationPresetSelect(presetSelect) {
    if (observedPresetSelect === presetSelect) {
        return;
    }

    if (observedPresetSelect && presetSelectChangeHandler) {
        observedPresetSelect.removeEventListener('change', presetSelectChangeHandler);
    }

    presetSelectObserver?.disconnect();
    observedPresetSelect = presetSelect;

    if (!presetSelect) {
        return;
    }

    presetSelectObserver = new MutationObserver(() => syncConnectionPresetSelect());
    presetSelectObserver.observe(presetSelect, { childList: true, subtree: true });

    presetSelectChangeHandler = () => syncConnectionPresetSelect();
    presetSelect.addEventListener('change', presetSelectChangeHandler);
}

/**
 * Mirrors the preset select of the active SillyTavern API into the top bar.
 * @returns {void}
 */
function syncConnectionPresetSelect() {
    const presetSelect = getActiveGenerationPresetSelect();
    observeActiveGenerationPresetSelect(presetSelect);

    if (!presetSelect || presetSelect.options.length === 0) {
        connectionPresetSelect.innerHTML = '';
        connectionPresetSelect.classList.add('displayNone');
        return;
    }

    connectionPresetSelect.classList.remove('displayNone');
    connectionPresetSelect.innerHTML = presetSelect.innerHTML;
    connectionPresetSelect.value = presetSelect.value;
    connectionPresetSelect.disabled = presetSelect.disabled;
}

/**
 * Wires the top bar preset dropdown to SillyTavern's preset selects.
 * The API-specific select can be rendered late, so binding waits for it and all
 * later panel opens / profile switches sync again.
 * @returns {void}
 */
function bindConnectionPresetSelect() {
    connectionPresetSelect.addEventListener('change', () => {
        const presetSelect = getActiveGenerationPresetSelect();

        if (!presetSelect) {
            syncConnectionPresetSelect();
            return;
        }

        presetSelect.value = connectionPresetSelect.value;
        presetSelect.dispatchEvent(new Event('change', { bubbles: true }));

        // Re-sync once SillyTavern finished applying the preset, so the dropdown
        // always reflects the selection the host actually ended up with.
        setTimeout(syncConnectionPresetSelect, 200);
    });

    document.getElementById('main_api')?.addEventListener('change', () => setTimeout(syncConnectionPresetSelect, 0));

    waitUntilCondition(() => getActiveGenerationPresetSelect() !== null, 15000, 250, { rejectOnTimeout: false })
        .then(() => syncConnectionPresetSelect())
        .catch(error => console.error(t`Failed to bind connection preset select`, error));
}

function bindConnectionProfilesSelect() {
    waitUntilCondition(() => document.getElementById('connection_profiles') !== null, 15000, 250, { rejectOnTimeout: false })
        .then(() => {
            const connectionProfilesMainSelect = /** @type {HTMLSelectElement} */ (document.getElementById('connection_profiles'));

            if (!connectionProfilesMainSelect) {
                console.warn(t`Connection profile selector not found. Connection profiles panel will be limited.`);
                connectionProfilesSelect.classList.add('displayNone');
                return;
            }

            connectionProfilesSelect.classList.remove('displayNone');
            connectionProfilesSelect.addEventListener('change', () => {
                connectionProfilesMainSelect.value = connectionProfilesSelect.value;
                connectionProfilesMainSelect.dispatchEvent(new Event('change'));
            });
            connectionProfilesMainSelect.addEventListener('change', () => {
                connectionProfilesSelect.value = connectionProfilesMainSelect.value;
            });

            const observer = new MutationObserver(() => {
                connectionProfilesSelect.innerHTML = connectionProfilesMainSelect.innerHTML;
                connectionProfilesSelect.value = connectionProfilesMainSelect.value;
            });
            observer.observe(connectionProfilesMainSelect, { childList: true });
            connectionProfilesMainSelect.addEventListener('change', () => setTimeout(syncConnectionPresetSelect, 200));
        })
        .catch(error => console.error(t`Failed to bind connection profiles`, error));
}

async function onToggleSidebarClick() {
    const sidebar = document.getElementById('extensionSideBar');
    const toggle = document.getElementById('extensionTopBarToggleSidebar');

    if (!sidebar || !toggle) {
        console.warn(t`Sidebar or toggle button not found`);
        return;
    }

    toggle.classList.toggle('active');
    const alreadyVisible = sidebar.classList.contains('visible');

    const keyframes = [
        { opacity: alreadyVisible ? 1 : 0 },
        { opacity: alreadyVisible ? 0 : 1 },
    ];
    const options = {
        duration: animation_duration,
        easing: animation_easing,
    };

    const animation = sidebar.animate(keyframes, options);

    if (alreadyVisible) {
        await animation.finished;
        sidebar.classList.toggle('visible');
        await populateSideBar();
    } else {
        sidebar.classList.toggle('visible');
        await populateSideBar();
        await animation.finished;
    }

    savePanelsState();
}

/**
 * Renders the past chats of the current character/group into the sidebar.
 * @param {Array<object|string>?} chatEntries Pre-fetched chat list, fetched again when omitted
 */
async function populateSideBar(chatEntries = null) {
    const sidebar = document.getElementById('extensionSideBar');
    const loader = document.getElementById('extensionSideBarLoader');
    const container = document.getElementById('extensionSideBarContainer');

    if (!loader || !container || !sidebar) {
        return;
    }

    if (!sidebar.classList.contains('visible')) {
        container.innerHTML = '';
        return;
    }

    loader.classList.remove('displayNone');
    const processId = uuidv4();
    const scrollTop = container.scrollTop;
    const prettify = x => {
        x.last_mes = timestampToMoment(x.last_mes);
        x.file_name = String(x.file_name).replace('.jsonl', '');
        return x;
    };
    container.dataset.processId = processId;
    const chatId = getCurrentChatId();
    const chats = (chatEntries ?? await getChatFiles())
        // Group chat info for an orphaned chat file returns `{ match: false }` with HTTP 200.
        .filter(entry => entry && typeof entry === 'object' && entry.file_name)
        .map(prettify)
        .sort((a, b) => sortMoments(a.last_mes, b.last_mes));

    if (container.dataset.processId !== processId) {
        console.log(t`Aborting populateSideBar due to process id mismatch`);
        return;
    }

    container.innerHTML = '';

    for (const chat of chats) {
        const sideBarItem = document.createElement('div');
        sideBarItem.classList.add('sideBarItem');

        sideBarItem.addEventListener('click', async () => {
            if (chat.file_name === chatId || sideBarItem.classList.contains('selected')) {
                return;
            }

            container.childNodes.forEach(x => x instanceof HTMLElement && x.classList.remove('selected'));
            sideBarItem.classList.add('selected');
            await openChatById(chat.file_name);
        });

        const isSelected = chat.file_name === chatId;
        sideBarItem.classList.toggle('selected', isSelected);

        const chatName = document.createElement('div');
        chatName.classList.add('chatName');
        chatName.textContent = chat.file_name;
        chatName.title = chat.file_name;

        const chatDate = document.createElement('small');
        chatDate.classList.add('chatDate');
        const hasValidDate = chat.last_mes?.isValid?.() === true;
        chatDate.textContent = hasValidDate ? chat.last_mes.format('l') : '';
        chatDate.title = hasValidDate ? chat.last_mes.format('LL LT') : '';

        const chatNameContainer = document.createElement('div');
        chatNameContainer.classList.add('chatNameContainer');
        chatNameContainer.append(chatName, chatDate);

        const chatMessage = document.createElement('div');
        chatMessage.classList.add('chatMessage');
        chatMessage.textContent = chat.mes ?? '';
        chatMessage.title = chat.mes ?? '';

        const chatStats = document.createElement('div');
        chatStats.classList.add('chatStats');

        const counterBlock = document.createElement('div');
        counterBlock.classList.add('counterBlock');

        const counterIcon = document.createElement('i');
        counterIcon.classList.add('fa-solid', 'fa-comment', 'fa-xs');

        const counterText = document.createElement('small');
        counterText.textContent = chat.chat_items;
        counterText.title = t`Messages in chat`;

        counterBlock.append(counterIcon, counterText);

        const fileSizeText = document.createElement('small');
        fileSizeText.classList.add('fileSize');
        fileSizeText.textContent = chat.file_size;
        fileSizeText.title = t`Chat file size`;

        chatStats.append(counterBlock, fileSizeText);

        const chatMessageContainer = document.createElement('div');
        chatMessageContainer.classList.add('chatMessageContainer');
        chatMessageContainer.append(chatMessage, chatStats);

        sideBarItem.append(chatNameContainer, chatMessageContainer);
        container.appendChild(sideBarItem);
    }

    container.scrollTop = scrollTop;

    const selectedElement = /** @type {HTMLElement?} */ (container.querySelector('.selected'));
    if (selectedElement) {
        const isSelectedElementVisible = selectedElement.offsetTop >= container.scrollTop
            && selectedElement.offsetTop <= container.scrollTop + container.clientHeight;
        if (!isSelectedElementVisible) {
            container.scrollTop = selectedElement.offsetTop - container.clientHeight / 2;
        }
    }

    loader.classList.add('displayNone');
}

async function openChatById(chatId) {
    if (!chatId) {
        return;
    }

    const context = SillyTavern.getContext();

    if (typeof openGroupChat === 'function' && context.groupId) {
        await openGroupChat(context.groupId, chatId);
        return;
    }

    if (typeof openCharacterChat === 'function' && context.characterId !== undefined) {
        await openCharacterChat(chatId);
    }
}

async function onChatNameChange() {
    const chatId = chatName.value;
    await openChatById(chatId);
}

async function onToggleConnectionProfilesClick() {
    const button = document.getElementById('extensionTopBarToggleConnectionProfiles');

    if (!button) {
        console.warn('Connection profiles button not found');
        return;
    }

    button.classList.toggle('active');
    connectionProfiles.classList.toggle('visible');
    savePanelsState();
    syncConnectionPresetSelect();
    await onOnlineStatusChange();
}

/**
 * Runs a read-only slash command and returns its value, if the command exists.
 * @param {string} name Slash command name
 * @param {object} args Named arguments
 * @returns {Promise<string?|null>}
 */
async function runQuietSlashCommand(name, args) {
    const command = SillyTavern.getContext().SlashCommandParser?.commands?.[name];

    if (typeof command?.callback !== 'function') {
        return null;
    }

    try {
        const result = await command.callback(args, '');
        return typeof result === 'string' ? result : null;
    } catch (error) {
        console.error(t`Slash command failed: ${name}`, error);
        return null;
    }
}

/**
 * Returns the display name of the currently selected API.
 * @returns {Promise<string>}
 */
async function getCurrentAPI() {
    const context = SillyTavern.getContext();
    let currentAPI = context.mainApi;

    const commandResult = await runQuietSlashCommand('api', { quiet: 'true' });
    if (commandResult) {
        currentAPI = commandResult;
    }

    if (!apiBlock) {
        return currentAPI;
    }

    const selects = [...apiBlock.querySelectorAll('select')];
    const orderedSelects = [
        ...selects.filter(select => select.id !== 'main_api'),
        ...selects.filter(select => select.id === 'main_api'),
    ];

    for (const select of orderedSelects) {
        const option = [...select.options].find(x => x.value && x.value === currentAPI);
        if (option) {
            // Remove text in parentheses or brackets, e.g. "OpenAI (GPT-4o)".
            return option.textContent.replace(/[[(].*[\])]/, '').trim();
        }
    }

    return currentAPI;
}

/**
 * Returns the display name of the currently selected model.
 * @returns {Promise<string>}
 */
async function getCurrentModel() {
    const context = SillyTavern.getContext();
    let currentModel = context.onlineStatus;

    const commandResult = await runQuietSlashCommand('model', { quiet: 'true' });
    if (commandResult) {
        currentModel = commandResult;
    }

    if (!apiBlock) {
        return currentModel;
    }

    // Skip empty-valued options (e.g. the connection profile "None" entry) so an
    // unknown model name does not get displayed as "None".
    const option = [...apiBlock.querySelectorAll('option')].find(x => x.value && x.value === currentModel);
    return option ? option.textContent.trim() : currentModel;
}

async function onOnlineStatusChange() {
    if (!connectionProfiles.classList.contains('visible')) {
        return;
    }

    const context = SillyTavern.getContext();
    const connectionProfilesMainSelect = /** @type {HTMLSelectElement} */ (document.getElementById('connection_profiles'));

    if (connectionProfilesMainSelect) {
        connectionProfilesSelect.classList.remove('displayNone');
        connectionProfilesSelect.innerHTML = connectionProfilesMainSelect.innerHTML;
        connectionProfilesSelect.value = connectionProfilesMainSelect.value;
    } else {
        connectionProfilesSelect.classList.add('displayNone');
    }

    syncConnectionPresetSelect();

    if (connectionProfilesStatus.nextElementSibling?.classList?.contains('icon-svg')) {
        connectionProfilesStatus.nextElementSibling.remove();
    }

    if (context.onlineStatus === 'no_connection') {
        connectionProfilesStatus.classList.add('offline');
        connectionProfilesStatus.textContent = t`No connection...`;

        const nullIcon = new Image();
        nullIcon.classList.add('icon-svg', 'null-icon');
        connectionProfilesStatus.insertAdjacentElement('afterend', nullIcon);
        return;
    }

    const [currentAPI, currentModel] = await Promise.all([getCurrentAPI(), getCurrentModel()]);
    await addConnectionProfileIcon();
    connectionProfilesStatus.classList.remove('offline');
    connectionProfilesStatus.textContent = `${currentAPI} – ${currentModel}`;
}

/**
 * Shows the icon of the generating API next to the model name.
 * Uses ST's SVGInject when available; the icon is purely decorative, so a missing
 * SVG implementation or a missing icon file is not an error for this extension.
 */
async function addConnectionProfileIcon() {
    const svgInject = /** @type {Function?} */ (window.SVGInject ?? SillyTavern.libs?.SVGInject);
    const modelName = getGeneratingApi?.();

    if (!svgInject || !modelName) {
        return;
    }

    await new Promise(resolve => {
        const image = new Image();
        image.classList.add('icon-svg');
        image.src = `/img/${modelName}.svg`;

        image.onload = async () => {
            connectionProfilesStatus.insertAdjacentElement('afterend', image);
            await svgInject(image);
            resolve();
        };

        image.onerror = () => resolve();

        // Never keep the status text waiting for a slow or missing icon.
        setTimeout(() => resolve(), 500);
    });
}

function savePanelsState() {
    try {
        localStorage.setItem('topBarPanelsState', JSON.stringify({
            sidebarVisible: document.getElementById('extensionSideBar')?.classList.contains('visible'),
            connectionProfilesVisible: document.getElementById('extensionConnectionProfiles')?.classList.contains('visible'),
        }));
    } catch (error) {
        console.error('Failed to save top bar panel state', error);
    }
}

function restorePanelsState() {
    let state;

    try {
        state = JSON.parse(localStorage.getItem('topBarPanelsState'));
    } catch (error) {
        console.warn('Ignoring invalid top bar panel state', error);
        return;
    }

    if (!state || typeof state !== 'object') {
        return;
    }

    if (state.sidebarVisible) {
        document.getElementById('extensionTopBarToggleSidebar')?.click();
    }

    if (state.connectionProfilesVisible) {
        document.getElementById('extensionTopBarToggleConnectionProfiles')?.click();
    }
}

/**
 * Reserves space for themes that take the top bar out of the normal flow
 * (position: fixed) so the bar never overlaps the first chat message.
 * Observes only the few relevant elements, no polling and no document-wide subtree.
 */
function observeTopBarLayout() {
    let frame = null;

    function update() {
        frame = null;
        const isFixed = getComputedStyle(topBar).position === 'fixed';
        const reserveSpace = isFixed && !document.body.classList.contains('waifuMode');

        if (reserveSpace) {
            const space = Math.max(0, topBar.getBoundingClientRect().bottom - sheld.getBoundingClientRect().top);
            const value = `${Math.ceil(space)}px`;
            if (sheld.style.getPropertyValue('--top-info-bar-space') !== value) {
                sheld.style.setProperty('--top-info-bar-space', value);
            }
        } else {
            sheld.style.removeProperty('--top-info-bar-space');
        }

        sheld.classList.toggle('top-info-bar-fixed-space', reserveSpace);
    }

    function schedule() {
        if (frame === null) {
            frame = requestAnimationFrame(update);
        }
    }

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(topBar);
    for (const id of ['top-bar', 'top-settings-holder']) {
        const element = document.getElementById(id);
        if (element) {
            resizeObserver.observe(element);
        }
    }

    const bodyObserver = new MutationObserver(schedule);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', schedule, { passive: true });

    // Theme stylesheets can load after the extension initialized.
    document.addEventListener('load', event => {
        if (event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') {
            schedule();
        }
    }, true);

    update();
}

// Init extension on load
(async function init() {
    if (!sheld || !chat) {
        console.error('Chat Top Bar: required SillyTavern elements (#sheld, #chat) are missing. Extension not initialized.');
        return;
    }

    patchSheldIfNeeded();
    addTopBar();
    addIcons();
    observeTopBarLayout();
    addSideBar();
    addConnectionProfiles();
    setChatName(getCurrentChatId());
    chatName.addEventListener('change', onChatNameChange);

    const setChatNameDebounced = debounce(() => setChatName(getCurrentChatId()), debounce_timeout.short);
    for (const eventName of [event_types.CHAT_CHANGED, event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED]) {
        eventSource.on(eventName, setChatNameDebounced);
    }

    eventSource.on(event_types.CHAT_CHANGED, () => {
        searchInput.value = '';
        highlightInChat(chat, '');
    });

    let panelsInitialized = false;
    const initPanelsOnce = () => {
        if (panelsInitialized) {
            return;
        }
        panelsInitialized = true;
        bindConnectionProfilesSelect();
        bindConnectionPresetSelect();
        restorePanelsState();
    };

    eventSource.once(event_types.APP_READY, initPanelsOnce);

    // Covers extension reloads after APP_READY has already been emitted.
    setTimeout(initPanelsOnce, 3000);

    eventSource.on(event_types.ONLINE_STATUS_CHANGED, updateStatusDebounced);
})();
