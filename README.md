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
- Prices are the Cardmarket trend in € × your rate × multiplier, never lower than your minimum. You can change these in Settings and tap **Re-apply auto prices**. Typing a price by hand stops it from being overwritten.
- Cards are saved on your phone (Safari storage) until you clear them, so you can scan in several sessions and export once.
- Render's free tier sleeps. The first scan after a while can take about 50 seconds while it wakes up.
