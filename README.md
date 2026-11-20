# HideFriends for Vencord

Hide chosen friends from your **Friends list** and your **DM list**, without removing or blocking them. They stay your friends and nothing changes on their side: they are only hidden on your screen.

## How to use it

- **Hide a friend:** right-click them (in the Friends list, in the DM list, in a server member list or on a message) and choose **Hide friend**.
- **Show them again:** right-click them anywhere and choose **Show friend again**, or open Settings > Vencord > Plugins > HideFriends and click **Show again** next to their name.

The plugin settings list every hidden friend, with a button to show them again one by one or all at once.

## What gets hidden

- The friend's row in the Friends list (Online and All tabs) and in its search.
- Your one-to-one DM conversation with them in the DM list. Group DMs are never hidden.

Hidden friends still show in servers, in group DMs, in the Active Now panel and in notifications. If a hidden friend sends you a message, you still get the notification, but the conversation stays out of the DM list. The friend counts in the Friends list headers may still include hidden friends.

## Settings

- **Hide from friends list** (on by default)
- **Hide from DM list** (on by default)
- **Hidden friends**: the list of hidden friends, with Show again buttons

Turning a setting off shows everyone again in that list right away, without forgetting who is hidden.

## Notes

- This plugin patches Discord's internal code for the Friends list and the DM list. A Discord update can break it: if that happens, the lists simply show everyone again until the plugin is updated.
- It works alongside Vencord's built-in **PinDMs**, **SortFriendRequests** and **ImplicitRelationships**, which patch the same lists. A pinned DM of a hidden friend stays in its PinDMs category.
- The hidden list is saved in your Vencord settings on this computer only.

## Installation

This is a user plugin, so it needs Vencord [built from source](https://docs.vencord.dev/installing/).

1. From the Vencord folder, clone this repo into `src/userplugins` (the folder is created if it doesn't exist yet):

   ```bash
   cd Vencord
   git clone https://github.com/TheUnknownMurda/HideFriends-Vencord src/userplugins/HideFriends
   ```

2. Build Vencord:

   ```bash
   pnpm build
   ```

3. If Discord doesn't load Vencord from this folder yet, inject it:

   ```bash
   pnpm inject
   ```

4. Fully quit Discord (from the system tray) and start it again, then enable **HideFriends** in Settings > Vencord > Plugins and restart Discord once more (the plugin patches Discord's code, which needs a restart).

### Updating

```bash
cd Vencord/src/userplugins/HideFriends
git pull
```

Then run `pnpm build` again and restart Discord.

## Credits

Made by [TheUnknownMurda](https://github.com/TheUnknownMurda), for [Vencord](https://github.com/Vendicated/Vencord).
