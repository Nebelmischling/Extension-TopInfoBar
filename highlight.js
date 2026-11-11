/**
 * Search highlighting for chat messages.
 *
 * This is a dependency-free replacement for the bundled jquery-highlight.js plugin.
 * The old plugin had two bugs that caused the "only some words are highlighted"
 * behavior reported in SillyTavern/Extension-TopInfoBar#4:
 *
 *  1. The query was split with `query.split(/\s|\b/)`, which produces empty strings.
 *     Those empty alternatives matched at index 0 and produced empty highlight spans,
 *     so the real words further down the same text node were never wrapped.
 *  2. The generated RegExp had no `g` flag and every text node was processed only once,
 *     so only the first match per text node got highlighted.
 *
 * The implementation below walks the text nodes of `.mes_text` (via TreeWalker), wraps
 * every non-overlapping match and leaves the rest of the message DOM untouched. It never
 * re-parses HTML, so message formatting (Markdown, code blocks, links, ...) is preserved.
 */

const HIGHLIGHT_CLASS = 'highlight';
const HIGHLIGHT_ELEMENT = 'mark';
const MESSAGE_TEXT_SELECTOR = '.mes_text';

/**
 * Elements whose text content must never be highlighted.
 * @type {string}
 */
const SKIPPED_ANCESTORS = 'script, style, textarea, select, option';

/**
 * Removes every highlight produced by {@link highlightInChat} below `root`.
 * @param {ParentNode} root
 */
export function clearChatHighlights(root) {
    const highlights = root.querySelectorAll(`${HIGHLIGHT_ELEMENT}.${HIGHLIGHT_CLASS}`);

    for (const highlight of highlights) {
        const parent = highlight.parentNode;
        if (!parent) {
            continue;
        }

        parent.replaceChild(document.createTextNode(highlight.textContent ?? ''), highlight);
        parent.normalize();
    }
}

/**
 * Splits a search query into the distinct words that should be highlighted.
 * @param {string} query
 * @returns {string[]}
 */
function getSearchWords(query) {
    return [...new Set(String(query ?? '').split(/\s+/).map(word => word.trim()).filter(Boolean))];
}

/**
 * Escapes a string so it can be used as a literal inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collects the text nodes worth highlighting below `root`.
 * @param {Node} root
 * @returns {Text[]}
 */
function getTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const text = node.nodeValue;
            const parent = node.parentElement;

            if (!text || !text.trim() || !parent) {
                return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest(SKIPPED_ANCESTORS) || parent.closest(`${HIGHLIGHT_ELEMENT}.${HIGHLIGHT_CLASS}`)) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodes = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }
    return nodes;
}

/**
 * Wraps all matches of `pattern` inside a single text node and replaces that node.
 * @param {Text} node
 * @param {RegExp} pattern
 * @returns {number} Number of highlighted matches
 */
function highlightTextNode(node, pattern) {
    const text = node.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let matches = 0;

    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        // Guard against zero-length matches (defensive: words are never empty).
        if (match[0].length === 0) {
            pattern.lastIndex++;
            continue;
        }

        if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const highlight = document.createElement(HIGHLIGHT_ELEMENT);
        highlight.className = HIGHLIGHT_CLASS;
        highlight.textContent = match[0];
        fragment.appendChild(highlight);

        lastIndex = match.index + match[0].length;
        matches++;
    }

    if (matches === 0) {
        return 0;
    }

    if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.parentNode?.replaceChild(fragment, node);
    return matches;
}

/**
 * Highlights every occurrence of the words in `query` inside the chat log.
 * Passing an empty query only clears previous highlights.
 *
 * @param {ParentNode} chatContainer Element that contains the chat messages (e.g. `#chat`).
 * @param {string} query Search query as typed by the user.
 * @returns {number} Number of highlighted matches.
 */
export function highlightInChat(chatContainer, query) {
    if (!chatContainer) {
        return 0;
    }

    clearChatHighlights(chatContainer);

    const words = getSearchWords(query);
    if (words.length === 0) {
        return 0;
    }

    const pattern = new RegExp(words.map(escapeRegExp).join('|'), 'gi');
    let matches = 0;

    for (const message of chatContainer.querySelectorAll(MESSAGE_TEXT_SELECTOR)) {
        for (const textNode of getTextNodes(message)) {
            matches += highlightTextNode(textNode, pattern);
        }
    }

    return matches;
}
