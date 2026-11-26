# PokeLister

Photograph Pokémon cards (front and back) on your iPhone. The app identifies them, fills in the listing details and item specifics, and exports a CSV that eBay turns into live listings (or drafts), with your photos, condition and policies attached.

How it works:

1. You take or choose photos. In **Front & back mode** you photograph each card's front, then its back.
2. The server sends each **front** to Claude (vision), which reads the name, number, set, finish, language and so on. Backs aren't sent to the AI.
3. The server matches each card against the free Pokémon TCG API (pokemontcg.io) and picks up the set name, rarity, stock image and Cardmarket trend price.
4. Front and back photos are uploaded to **ImgBB**, a free image host, so eBay has web links it can pull them from.
5. You review the cards. Anything marked **Check** (orange border) needs a look.
6. Tap **Download CSV** (or **Share CSV** to save it to Files), then upload it to eBay Seller Hub. By default the cards go live straight away.

Zero dependencies, Node 18+, vanilla HTML/JS.

## Files

```
package.json
server.js            backend: AI identify, card lookup, search, photo upload, static files
public/index.html
public/style.css
public/app.js        frontend: queue, front/back pairing, review list, CSV export
```

## Render environment variables

| Variable | Needed? | What it's for |
|---|---|---|
| `ANTHROPIC_API_KEY` | Required | Reads the cards in your photos |
| `APP_PASSWORD` | Strongly recommended | Stops anyone else using your API credit |
| `IMGBB_API_KEY` | Needed for photos in listings | Hosts your front/back photos |
| `PULSE_API_KEY` | Needed for Pulse prices | Same PulseTCG key PokeSnipe uses |
| `PULSE_DAILY_LIMIT` | Optional | Max Pulse lookups per day from PokeLister (default 400) |
| `POKEMONTCG_API_KEY` | Optional | Higher card-lookup rate limit (free at dev.pokemontcg.io) |
| `MODEL` | Optional | Defaults to `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper |

### Getting the ImgBB key

1. Sign up at imgbb.com.
2. Go to **api.imgbb.com** while signed in and click **Get API key**.
3. In Render, open your service → **Environment** → add `IMGBB_API_KEY` with that key, then save. Render redeploys.
4. Open PokeLister → ⚙︎ Settings. The status line should end with "Photo hosting on".

## Scanning

**Front & back mode** (the tick box under the scan buttons, on by default):

- **Camera:** take the front, then the back, then the next front, and so on. The bar under the tick box tells you whether the next photo should be a FRONT or a BACK. Tap **Skip back** if a card doesn't need one.
- **Library:** select the photos in order: front, back, front, back…
- Each photo in the queue is labelled FRONT or BACK, so you can see the pairing.

**Mode off:** every photo is treated as a front. If you do photograph a back, the AI recognises it and attaches it to the previous card.

**On each card** you can tap **Add back** / **Replace back** or **Replace front**. Use these to fix a mix-up, add a missing back, or retry a photo that failed to upload. Each card shows "Listing photos: front ✓ · back ✓" so you can see what will be attached.

**Binder pages:** the whole page photo becomes the front photo for every card on it. Use Add back on individual cards if you want backs for those.

## Japanese, Chinese and other Asian cards

English and European-language cards are matched against pokemontcg.io. Japanese, Chinese,
Korean, Thai and Indonesian cards are matched against TCGdex (free, no key needed), using the
name printed on the card and its number. Titles and item specifics still use the English
card name (e.g. "Ludicolo 081/080 Mega Dream ex Japanese Art Rare (AR)") so eBay UK buyers
find them. Pulse prices are taken from the Japanese/Chinese printing, never the English one.

If the AI gets a card's language wrong, change **Card language** on the card and it is looked
up again in the right database.

## Item specifics

Each card has an **Item specifics** section. Tap it to open. PokeLister fills in Game, Card Name, Character, Card Type, Set, Card Number, Rarity, Finish, Language, Manufacturer, Year Manufactured, Features (1st Edition) and Graded (No) from the card match.

- Anything it couldn't find is outlined orange and counted as "missing", both on the card and in the summary bar. Just type it in.
- Your edits stick even if you change the match. **Undo my edits** goes back to the automatic values.
- **Extra specifics:** add anything else eBay asks for, one per line as `Name: Value`, e.g. `Attribute/MTG:Colour: Colorless` or `Age Level: 6+`.
- Change the defaults for Game and Manufacturer in Settings.

## Export mode

Settings → **Export as**:

- **Live listings** (default): uploading the CSV lists the cards straight away, with:
  - condition **Ungraded** plus the card condition you picked (Near Mint, Lightly/Moderately/Heavily Played; Damaged is sent as Heavily Played)
  - all item specifics
  - your postage, returns and payment policies, item location and an optional Best Offer
  - Good 'Til Cancelled, fixed price, and your front and back photos
- **Drafts:** the same file, but as drafts with item specifics. eBay's drafts upload ignores policies and condition, so you set those on each draft.

### Live listing setup (once)

In PokeLister → ⚙︎ Settings → **Live listings**, fill in:

- **Postage policy name** and **Returns policy name**, exactly as they appear in eBay (Account → Business policies, or check what's selected on a listing).
- **Payment policy name** (optional; leave blank if you don't have one).
- **Item postcode** (required by eBay) and optionally your town.

These are stored only on your phone.

Live listings can't be checked on eBay before they go live, so PokeLister is where you review everything. Export asks you to confirm before creating a live-listings file, and blocks the export if any card has no price.

## Pricing rule

Default rule: **listing price = Pulse price − 10%**, never below your **Min £**. Postage is separate; buyers pay it through your postage policy.

- After a card is identified, PokeLister looks up its PulseTCG price (Cardmarket Near Mint, in £), the same way PokeSnipe does.
- Every card shows the rule as a reminder, e.g. "Rule (set in Settings): Pulse £4.70 − 10% = £4.23". The summary bar and Settings → Pricing show it too.
- **No Pulse match?** Type the price from the PulseTCG app into **Pulse price £** on the card. The same rule is applied.
- Pulse is only trusted when it matches both the set and the card number, so a live listing never gets another printing's price.
- Changing the match re-checks Pulse. Lookups are cached for a day, and PokeLister stops at `PULSE_DAILY_LIMIT` lookups a day, because PokeSnipe uses the same 1,000-credit daily budget.
- Change the discount, minimum or source (Pulse or Cardmarket) in Settings → Pricing, then tap **Re-apply auto prices** to reprice everything.

## Pre-upload check

Download CSV, Share CSV and List on eBay all open the pre-upload check first. It fixes what it
safely can (postage line at the top of every description, titles over 80 characters, item
specifics over 65, prices below your minimum), leaves out cards that can't go yet (no price,
photo not uploaded, already live on eBay) and flags the rest with a Show button.

## Bulk edit and quick review

- **Select & bulk edit**: tick cards (or "All shown" after tapping a filter like "4 no price"),
  then Edit… to set condition, finish, language, price, qty or Mark OK for all of them at once.
- **Review cards**: one card at a time with a big photo. ✓ Looks good marks it OK and moves on.
  It reviews the cards currently shown, so tap "4 to check" first to review just those.

## List straight to eBay (optional)

1. Sign in at https://developer.ebay.com with your eBay account and create a developer account (free).
2. Application Keys → create a **Production** keyset. Copy the App ID (Client ID) and Cert ID (Client Secret).
   If eBay asks about marketplace account deletion notifications, choose that you don't store eBay user data (opt out).
3. User Tokens → "Get a Token from eBay via Your Application" → add an eBay Redirect URL (RuName):
   - Auth accepted URL: `https://pokelister.onrender.com/api/ebay/callback`
   - Auth declined URL: `https://pokelister.onrender.com/api/ebay/callback`
   - Privacy policy URL: `https://pokelister.onrender.com/`
   Copy the RuName (looks like `Your_Name-YourApp-PRD-abc123-xyz`).
4. On Render → Environment add `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_RUNAME`.
5. In PokeLister → Settings → List straight to eBay → Connect eBay account, sign in, Agree.
   Then tap Check my policies to make sure your postage/returns policy names are found.
6. A **List on eBay** button appears at the bottom. Use "Test 1 card first" the first time:
   eBay checks the card without listing it.

The eBay sign-in is stored on your phone, encrypted by the server. Connect once on each device.
Listed cards show their eBay item number; "Remove listed" clears them from PokeLister.

## Uploading to eBay

1. Seller Hub → **Reports** → **Uploads** → **Upload template**, then pick the CSV.
2. Wait for the result. **Live mode:** the cards appear under **Listings → Active**. **Drafts mode:** they appear under **Listings → Drafts**.
3. If anything fails, download eBay's results file. It gives the reason for each row.

When a listing is created, eBay copies the photos onto its own servers, so the ImgBB copies only need to exist until then.

**First time:** test with one cheap card. If eBay complains about a column name (item specific names can differ slightly on eBay UK), download the category template for 183454 from Seller Hub (Reports → Uploads → Download template), check the exact `C:` names, and either tell me or use the Extra specifics box.

### If eBay rejects the file

The template format changes occasionally. In Seller Hub, go to Reports → Uploads → Download template → **Create drafts** and compare its top lines with the first two lines of the exported CSV. If they differ, tell me what eBay's version shows and I'll update `buildCSV` in `app.js`.

## Tips

- Lay cards flat in good light, out of toploaders if you can. Glare on holos is the most common cause of misreads.
- **Check** means the AI wasn't confident, the number didn't match exactly, or it couldn't tell the finish. Reverse holo vs normal is the most common miss.
- Typing a price by hand stops it from being overwritten. **Apply rule** puts the rule's price back.
- Cards are saved on your phone (Safari storage) until you clear them, so you can scan in several sessions and export once.
- Render's free tier sleeps. The first scan after a while can take about 50 seconds while it wakes up.
