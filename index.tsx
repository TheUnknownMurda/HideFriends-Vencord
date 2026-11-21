/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Menu, PresenceStore, React, RelationshipStore, UserStore } from "@webpack/common";

import managedStyle from "./style.css?managed";

const logger = new Logger("HideFriends");

/** Found when first used, not when the file loads (Discord's stores don't exist yet at that point) */
const FriendsStore = findStoreLazy("FriendsStore");
/** Builds the cards of the "Active Now" panel, on the right of the Friends page */
const NowPlayingViewStore = findStoreLazy("NowPlayingViewStore");

/** Discord's numbers: relationship type 1 = friend, channel type 1 = one-to-one DM, activity type 4 = custom status */
const FRIEND = 1;
const DM = 1;
const CUSTOM_STATUS = 4;

/** Id of the "Hidden" tab in the Friends page (Discord's own tabs are ONLINE, ALL, PENDING...) */
const HIDDEN_SECTION = "HIDDEN_FRIENDS";

/** user id -> username saved when the friend was hidden (shown in the settings list) */
type HiddenUsers = Record<string, string>;

const settings = definePluginSettings({
    hideFromFriendsList: {
        type: OptionType.BOOLEAN,
        description: "Hide hidden friends from the Online and All tabs of the Friends list (and their search)",
        default: true,
        onChange: () => refreshLists()
    },
    hideFromDmList: {
        type: OptionType.BOOLEAN,
        description: "Hide the direct message conversations of hidden friends from the DM list",
        default: true,
        onChange: () => refreshLists()
    },
    hideFromActiveNow: {
        type: OptionType.BOOLEAN,
        description: "Hide hidden friends from the Active Now panel, on the right of the Friends page",
        default: true,
        onChange: () => refreshLists()
    },
    showHiddenTab: {
        type: OptionType.BOOLEAN,
        description: "Show a \"Hidden\" tab next to Online and All in the Friends page, listing your hidden friends",
        default: true,
        onChange: (show: boolean) => {
            if (!show) leaveHiddenTab();
            refreshLists();
        }
    },
    hiddenList: {
        type: OptionType.COMPONENT,
        component: ErrorBoundary.wrap(HiddenFriendsSetting, { noop: true })
    },
    hiddenUsers: {
        type: OptionType.CUSTOM,
        default: {} as HiddenUsers
    }
});

function getHidden(): HiddenUsers {
    return settings.store.hiddenUsers ?? {};
}

function isHidden(userId: string | undefined | null) {
    return !!userId && Object.hasOwn(getHidden(), userId);
}

function rowUserId(row: any): string | undefined {
    return row?.userId ?? row?.user?.id ?? row?.id;
}

function currentFriendsSection(): string | undefined {
    try {
        return FriendsStore.getState()?.section;
    } catch {
        return undefined;
    }
}

/** Don't leave the Friends page on a tab that is no longer shown */
function leaveHiddenTab() {
    if (currentFriendsSection() !== HIDDEN_SECTION) return;
    try {
        FluxDispatcher.dispatch({ type: "FRIENDS_SET_SECTION", section: "ALL" });
    } catch (e) {
        logger.error("Could not leave the Hidden tab", e);
    }
}

let forceUpdateDmList: (() => void) | undefined;

/** Makes Discord redraw the Friends list, the DM list and Active Now right away */
function refreshLists() {
    try {
        RelationshipStore?.emitChange?.();
    } catch (e) {
        logger.error("Could not refresh the Friends list", e);
    }
    try {
        NowPlayingViewStore?.emitChange?.();
    } catch (e) {
        logger.error("Could not refresh Active Now", e);
    }
    forceUpdateDmList?.();
}

type MaybeUser = { id?: string; } | null | undefined;

function asList(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

/** Same game or app (Spotify and other activities without an application id are compared by type and name) */
function sameApp(a: any, b: any) {
    if (a?.application_id || b?.application_id) return a?.application_id === b?.application_id;
    return a?.type === b?.type && a?.name === b?.name;
}

/**
 * Active Now shows one activity per game on a card, with the details of whoever comes first.
 * When that was a hidden friend, this looks for a visible friend whose own activity is the same game
 * (their main activity, the one Discord would have used for them).
 */
function findVisibleActivity(activity: any, candidates: MaybeUser[]) {
    if (activity == null) return null;
    for (const user of candidates) {
        if (!user?.id) continue;
        const own = asList(PresenceStore.getActivities(user.id)).find(a => a != null && a.type !== CUSTOM_STATUS);
        if (own && sameApp(own, activity)) {
            return { activity: own, activityUser: user, startedPlayingTime: own.timestamps?.start ?? own.created_at };
        }
    }
    return null;
}

/**
 * One Active Now card ("party"): removes hidden friends from it.
 * Returns the same party when no hidden friend is on it, a cleaned copy,
 * or null when the card should go (it was only about hidden friends, or nothing would be left on it).
 */
function cleanActiveNowParty(party: any, hidden: HiddenUsers): any {
    const isHiddenUser = (user: MaybeUser) => !!user?.id && Object.hasOwn(hidden, user.id);

    const priority = asList(party.priorityMembers);
    const partied = asList(party.partiedMembers);
    const voice = asList(party.voiceChannels);
    const activities = asList(party.currentActivities);
    const streams = asList(party.applicationStreams);

    const involved = priority.some(m => isHiddenUser(m?.user))
        || partied.some(isHiddenUser)
        || voice.some(vc => asList(vc?.members).some(isHiddenUser))
        || activities.some(a => isHiddenUser(a?.activityUser) || asList(a?.playingMembers).some(isHiddenUser))
        || streams.some(s => isHiddenUser(s?.streamUser));
    if (!involved) return party;

    // The friends the card is about (avatar and names at its top). Only hidden friends: the card goes
    const priorityMembers = priority.filter(m => !isHiddenUser(m?.user));
    if (!priorityMembers.length) return null;

    const voiceChannels = voice
        .map(vc => {
            const members = asList(vc?.members);
            const visible = members.filter(u => !isHiddenUser(u));
            return visible.length === members.length ? vc : { ...vc, members: visible };
        })
        .filter(vc => asList(vc?.members).length > 0);

    const currentActivities: any[] = [];
    for (const entry of activities) {
        const members = asList(entry?.playingMembers);
        const playingMembers = members.filter(u => !isHiddenUser(u));
        if (!isHiddenUser(entry?.activityUser)) {
            currentActivities.push(playingMembers.length === members.length ? entry : { ...entry, playingMembers });
            continue;
        }
        // The game was shown with the hidden friend's details: keep it only if a visible friend of the card plays it too
        const swap = findVisibleActivity(entry?.activity, priorityMembers.map(m => m?.user));
        if (swap) currentActivities.push({ ...entry, ...swap, playingMembers });
    }

    const applicationStreams = streams.filter(s => !isHiddenUser(s?.streamUser));

    // Same rule as Discord: a card needs a voice channel, an activity or a stream to be shown
    if (!voiceChannels.length && !currentActivities.length && !applicationStreams.length) return null;

    return {
        ...party,
        priorityMembers,
        partiedMembers: partied.filter(u => !isHiddenUser(u)),
        voiceChannels,
        currentActivities,
        applicationStreams
    };
}

/** Last Active Now result, given back as long as nothing changed (so Discord doesn't redraw for nothing) */
let activeNowCache: { cards: unknown; key: string; result: unknown; } | undefined;

function filterActiveNow(cards: unknown) {
    try {
        if (!Array.isArray(cards)) return cards;
        const hidden: HiddenUsers = settings.store.hideFromActiveNow ? getHidden() : {};
        const key = Object.keys(hidden).join(",");
        if (activeNowCache?.cards === cards && activeNowCache.key === key) return activeNowCache.result;

        let result: unknown[] = cards;
        if (key) {
            const kept: unknown[] = [];
            for (const card of cards) {
                const party = card?.party;
                if (party == null || typeof party !== "object") {
                    kept.push(card);
                    continue;
                }
                const cleaned = cleanActiveNowParty(party, hidden);
                if (cleaned === null) continue;
                kept.push(cleaned === party ? card : { ...card, party: cleaned });
            }
            if (kept.length !== cards.length || kept.some((card, i) => card !== cards[i])) result = kept;
        }

        activeNowCache = { cards, key, result };
        return result;
    } catch (e) {
        logger.error("Active Now filter failed", e);
        return cards;
    }
}

function setHidden(userId: string, hidden: boolean) {
    const next = { ...getHidden() };
    if (hidden) {
        const user = UserStore.getUser(userId);
        next[userId] = user ? (user.globalName || user.username) : userId;
    } else {
        delete next[userId];
    }
    settings.store.hiddenUsers = next; // a new object, so the settings page updates too
    refreshLists();
}

function unhideAll() {
    settings.store.hiddenUsers = {};
    refreshLists();
}

function displayName(userId: string, saved: string) {
    const user = UserStore.getUser(userId);
    if (!user) return { name: saved, sub: "", avatar: undefined as string | undefined };
    return {
        name: user.globalName || user.username,
        sub: user.username,
        avatar: user.getAvatarURL?.(undefined, 40, false)
    };
}

function HiddenFriendsSetting() {
    const { hiddenUsers } = settings.use(["hiddenUsers"]);
    const entries = Object.entries((hiddenUsers ?? {}) as HiddenUsers);

    if (!entries.length) {
        return (
            <div className="vc-hidefriends-empty">
                No hidden friends. Right-click a friend (in the Friends list, a DM or a server) and choose "Hide friend".
            </div>
        );
    }

    return (
        <div className="vc-hidefriends-list">
            <div className="vc-hidefriends-title">Hidden friends ({entries.length})</div>
            {entries.map(([id, saved]) => {
                const { name, sub, avatar } = displayName(id, saved);
                return (
                    <div key={id} className="vc-hidefriends-row">
                        {avatar
                            ? <img className="vc-hidefriends-avatar" src={avatar} alt="" />
                            : <div className="vc-hidefriends-avatar" />}
                        <div className="vc-hidefriends-names">
                            <div className="vc-hidefriends-name">{name}</div>
                            {sub && sub !== name && <div className="vc-hidefriends-sub">{sub}</div>}
                        </div>
                        <button className="vc-hidefriends-button" onClick={() => setHidden(id, false)}>
                            Unhide
                        </button>
                    </div>
                );
            })}
            {entries.length > 1 && (
                <button className="vc-hidefriends-button vc-hidefriends-all" onClick={unhideAll}>
                    Unhide all
                </button>
            )}
        </div>
    );
}

/** "Hide friend" / "Unhide friend" in the right-click menu and in the "..." menu of profiles */
const userMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const user = props?.user;
    if (!user?.id) return;
    const hidden = isHidden(user.id);
    // Offered for friends, and for anyone already hidden (so they can always be unhidden)
    if (!hidden && RelationshipStore.getRelationshipType(user.id) !== FRIEND) return;

    children.push(
        <Menu.MenuItem
            id="vc-hidefriends-toggle"
            label={hidden ? "Unhide friend" : "Hide friend"}
            action={() => setHidden(user.id, !hidden)}
        />
    );
};

export default definePlugin({
    name: "HideFriends",
    description: "Hide chosen friends from your Friends list, DM list and Active Now. Right-click a friend and choose \"Hide friend\". Hidden friends are listed in a \"Hidden\" tab of the Friends page, where a right-click > \"Unhide friend\" brings them back.",
    authors: [{ name: "TheUnknownMurda", id: 338163169782398977n }],
    tags: ["Friends", "Organisation"],
    settings,
    managedStyle,

    contextMenus: {
        "user-context": userMenuPatch,
        "user-profile-actions": userMenuPatch,
        "user-profile-overflow-menu": userMenuPatch
    },

    // These patches depend on Discord's internal code and can stop working after a Discord update.
    // They reuse the spots that Vencord's built-in plugins (SortFriendRequests, ImplicitRelationships, PinDMs)
    // patch, and still match when those plugins are enabled (user plugins are patched after built-in ones).
    patches: [
        // Friends list rows: removes hidden friends from every tab except "Hidden"
        {
            find: "getRelationshipCounts(){",
            replacement: {
                match: /(\}\)\.sortBy\(.+?\))\.value\(\)/,
                replace: "$1.filter(r=>$self.keepFriendRow(r,arguments[0])).value()"
            }
        },
        // "Hidden" tab content: which rows belong to it
        {
            find: '"FriendsStore"',
            replacement: {
                match: /(?<=case \i\.\i\.SUGGESTIONS:return \d+===(\i)\.type)/,
                replace: `;case "${HIDDEN_SECTION}":return $self.isHiddenFriendRow($1)`
            }
        },
        // "Hidden" tab button, next to Online and All (inserted just before Pending)
        {
            find: "#{intl::FRIENDS_SECTION_ONLINE}),className:",
            replacement: {
                match: /,\{id:\i\.\i\.PENDING,show:.+?className:(\i\.\i)(?=\},\{id:)/,
                replace: `,{id:"${HIDDEN_SECTION}",show:$self.showHiddenTab(),className:$1,content:"Hidden"}$&`
            }
        },
        // Title above the list in the "Hidden" tab ("Hidden friends — 3")
        {
            find: "#{intl::FRIENDS_ALL_HEADER}",
            replacement: {
                match: /toString\(\)\}\);(?=case \i\.\i\.\i:)/,
                replace: `$&case "${HIDDEN_SECTION}":return "Hidden friends — "+arguments[1];`
            }
        },
        // Picture shown when the "Hidden" tab is empty (Discord shows an error for tabs it doesn't know)
        {
            find: "FriendsEmptyState: Invalid empty state",
            replacement: {
                match: /(?<=case \i\.\i\.ONLINE:(?:case \i\.\i\.\i:)*)(?=return \i\.SECTION_ONLINE)/,
                replace: `case "${HIDDEN_SECTION}":`
            }
        },
        // DM list conversations (same spot as the built-in PinDMs plugin; works with or without it)
        {
            find: '"dm-quick-launcher"===',
            replacement: {
                match: /(?<=channels:\i,privateChannelIds:)[^,]+?(?=,listRef:)/,
                replace: "$self.filterDms($&)"
            }
        },
        // Lets the plugin redraw the DM list when you hide or unhide someone
        {
            find: ".FRIENDS},\"friends\"",
            replacement: {
                match: /let{showLibrary:\i,/,
                replace: "$self.useDmListUpdater();$&"
            }
        },
        // Active Now panel (right of the Friends page): its list of cards goes through filterActiveNow.
        // The built-in ShowHiddenChannels patches another spot of the same store, both work together.
        {
            find: '"NowPlayingViewStore"',
            replacement: {
                match: /(?<=get nowPlayingCards\(\)\{return )\i(?=\})/,
                replace: "$self.filterActiveNow($&)"
            }
        }
    ],

    showHiddenTab() {
        return settings.store.showHiddenTab !== false;
    },

    isHiddenFriendRow(row: any) {
        try {
            return row?.type === FRIEND && isHidden(rowUserId(row));
        } catch {
            return false;
        }
    },

    keepFriendRow(row: any, section: unknown) {
        try {
            // Discord's tab names are like ONLINE, ALL, PENDING; otherwise ask the store which tab is open
            const tab = typeof section === "string" && /^[A-Z_]+$/.test(section) ? section : currentFriendsSection();
            // In the "Hidden" tab, the rows were already narrowed to hidden friends
            if (tab === HIDDEN_SECTION) return true;
            if (!settings.store.hideFromFriendsList) return true;
            return !isHidden(rowUserId(row));
        } catch (e) {
            logger.error("Friends list filter failed", e);
            return true;
        }
    },

    filterDms(channelIds: string[]) {
        try {
            if (!settings.store.hideFromDmList || !Array.isArray(channelIds)) return channelIds;
            const hidden = getHidden();
            if (!Object.keys(hidden).length) return channelIds;
            return channelIds.filter(id => {
                const channel = ChannelStore.getChannel(id);
                if (!channel || channel.type !== DM) return true; // group DMs stay
                return !Object.hasOwn(hidden, channel.recipients?.[0]);
            });
        } catch (e) {
            logger.error("DM list filter failed", e);
            return channelIds;
        }
    },

    filterActiveNow,

    useDmListUpdater() {
        const [, setTick] = React.useState(0);
        forceUpdateDmList = () => setTick(t => t + 1);
    },

    stop() {
        forceUpdateDmList = undefined;
        leaveHiddenTab();
    }
});
