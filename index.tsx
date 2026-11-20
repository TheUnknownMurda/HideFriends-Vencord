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
import { ChannelStore, Menu, React, RelationshipStore, UserStore } from "@webpack/common";

import managedStyle from "./style.css?managed";

const logger = new Logger("HideFriends");

/** Discord's numbers: relationship type 1 = friend, channel type 1 = one-to-one DM */
const FRIEND = 1;
const DM = 1;

/** user id -> username saved when the friend was hidden (shown in the settings list) */
type HiddenUsers = Record<string, string>;

const settings = definePluginSettings({
    hideFromFriendsList: {
        type: OptionType.BOOLEAN,
        description: "Hide hidden friends from the Friends list (Online, All) and its search",
        default: true,
        onChange: () => refreshLists()
    },
    hideFromDmList: {
        type: OptionType.BOOLEAN,
        description: "Hide the direct message conversations of hidden friends from the DM list",
        default: true,
        onChange: () => refreshLists()
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

let forceUpdateDmList: (() => void) | undefined;

/** Makes Discord redraw the Friends list and the DM list right away */
function refreshLists() {
    try {
        // Stores are read here, never at the top of the file (they don't exist yet when the file loads)
        RelationshipStore?.emitChange?.();
    } catch (e) {
        logger.error("Could not refresh the Friends list", e);
    }
    forceUpdateDmList?.();
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
                            Show again
                        </button>
                    </div>
                );
            })}
            {entries.length > 1 && (
                <button
                    className="vc-hidefriends-button vc-hidefriends-all"
                    onClick={() => { settings.store.hiddenUsers = {}; refreshLists(); }}
                >
                    Show all of them again
                </button>
            )}
        </div>
    );
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user) return;
    const hidden = isHidden(user.id);
    // Offer it for friends, and for anyone already hidden (so they can always be shown again)
    if (!hidden && RelationshipStore.getRelationshipType(user.id) !== FRIEND) return;

    children.push(
        <Menu.MenuItem
            id="vc-hidefriends-toggle"
            label={hidden ? "Show friend again" : "Hide friend"}
            action={() => setHidden(user.id, !hidden)}
        />
    );
};

export default definePlugin({
    name: "HideFriends",
    description: "Hide chosen friends from your Friends list and DM list. Right-click a friend and choose \"Hide friend\"; show them again from the same menu or from this plugin's settings.",
    authors: [{ name: "TheUnknownMurda", id: 338163169782398977n }],
    tags: ["Friends", "Organisation"],
    settings,
    managedStyle,

    contextMenus: {
        "user-context": userContextPatch
    },

    // These patches depend on Discord's internal code and can stop working after a Discord update.
    // If that happens, Vencord shows the plugin's patch as failed and the lists simply show everyone.
    patches: [
        // Friends list rows (same spot the built-in SortFriendRequests plugin patches)
        {
            find: "getRelationshipCounts(){",
            replacement: {
                match: /(\}\)\.sortBy\(.+?\))\.value\(\)/,
                replace: "$1.filter(r=>$self.keepFriendRow(r)).value()"
            }
        },
        // DM list conversations (same spot the built-in PinDMs plugin patches; works with or without it)
        {
            find: '"dm-quick-launcher"===',
            replacement: {
                match: /(?<=channels:\i,privateChannelIds:)[^,]+?(?=,listRef:)/,
                replace: "$self.filterDms($&)"
            }
        },
        // Lets the plugin redraw the DM list when you hide or show someone
        {
            find: ".FRIENDS},\"friends\"",
            replacement: {
                match: /let{showLibrary:\i,/,
                replace: "$self.useDmListUpdater();$&"
            }
        }
    ],

    keepFriendRow(row: any) {
        try {
            if (!settings.store.hideFromFriendsList) return true;
            const id = row?.user?.id ?? row?.userId ?? row?.id;
            return !isHidden(id);
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

    useDmListUpdater() {
        const [, setTick] = React.useState(0);
        forceUpdateDmList = () => setTick(t => t + 1);
    },

    stop() {
        forceUpdateDmList = undefined;
    }
});
