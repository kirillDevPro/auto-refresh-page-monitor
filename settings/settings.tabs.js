// settings.tabs.js — settings page tab navigation.
// Wires click handlers on .tabs-navigation .tab-link elements so selecting a tab
// toggles the matching .tab-content panel active, and activates a default tab on init.

/**
 * Initialize the settings-page tab navigation.
 *
 * Attaches a click listener to each `.tabs-navigation .tab-link` that clears the
 * `active` class from all links and panels, then marks the clicked link and its
 * matching `.tab-content` (resolved via getElementById from the link's `data-tab`)
 * active, warning if that content id is not found. After binding, if no link is
 * pre-marked active it clicks the first one; otherwise, if the pre-marked link's
 * content panel is not already active, it clears every panel and activates that
 * one. Warns and returns early if no tab links or tab-content elements exist.
 *
 * @returns {void}
 */
export function initializeTabs() {
    const tabLinks = document.querySelectorAll('.tabs-navigation .tab-link');
    const tabContents = document.querySelectorAll('.tab-content');

    if (tabLinks.length === 0 || tabContents.length === 0) {
        console.warn("Tab elements not found for initialization.");
        return;
    }

    tabLinks.forEach(link => {
        link.addEventListener('click', () => {
            const tabId = link.dataset.tab;
            tabLinks.forEach(l => l.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            link.classList.add('active');
            const activeTabContent = document.getElementById(tabId);
            if (activeTabContent) {
                activeTabContent.classList.add('active');
            } else {
                console.warn(`Tab content with id "${tabId}" not found.`);
            }
        });
    });

    // Activate the first tab by default if none are active
    const activeLink = document.querySelector('.tabs-navigation .tab-link.active');
    if (!activeLink && tabLinks.length > 0) {
        tabLinks[0].click();
    } else if (activeLink) {
        // Ensure corresponding content is active
        const activeContentId = activeLink.dataset.tab;
        const activeContent = document.getElementById(activeContentId);
        if (activeContent && !activeContent.classList.contains('active')) {
            tabContents.forEach(c => c.classList.remove('active'));
            activeContent.classList.add('active');
        }
    }
}
