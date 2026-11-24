# PokeLister

Photograph Pokémon cards (front and back) on your iPhone. The app identifies them, fills in the listing details and exports a CSV that eBay turns into draft listings with your photos attached.

How it works:

1. You take or choose photos. In **Front & back mode** you photograph each card's front, then its back.
2. The server sends each **front** to Claude (vision), which reads the name, number, set, finish, language and so on. Backs aren't sent to the AI.
3. The server matches each card against the free Pokémon TCG API (pokemontcg.io) and picks up the set name, rarity, stock image and Cardmarket trend price.
4. Front and back photos are uploaded to **ImgBB**, a free image host, so eBay has web links it can pull them from.
5. You review the cards. Anything marked **Check** (orange border) needs a look.
6. Tap **Download CSV** (or **Share CSV** to save it to Files), then upload it to eBay Seller Hub. The listings appear as drafts with the front and back photos attached.

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

## Uploading to eBay

1. Seller Hub → **Reports** → **Uploads** → **Upload template**, then pick the CSV.
2. Go to **Listings → Drafts**. Each draft has the title, price, quantity, category, description and your front and back photos.
3. Set the condition (Graded/Ungraded plus card condition) and any item specifics, then list.

When a listing is created, eBay copies the photos onto its own servers, so the ImgBB copies only need to exist until then.

### If eBay rejects the file

The template format changes occasionally. In Seller Hub, go to Reports → Uploads → Download template → **Create drafts** and compare its top lines with the first two lines of the exported CSV. If they differ, tell me what eBay's version shows and I'll update `buildCSV` in `app.js`.

## Tips

- Lay cards flat in good light, out of toploaders if you can. Glare on holos is the most common cause of misreads.
- **Check** means the AI wasn't confident, the number didn't match exactly, or it couldn't tell the finish. Reverse holo vs normal is the most common miss.
- Prices are the Cardmarket trend in € × your rate × multiplier, never lower than your minimum. You can change these in Settings and tap **Re-apply auto prices**. Typing a price by hand stops it from being overwritten.
- Cards are saved on your phone (Safari storage) until you clear them, so you can scan in several sessions and export once.
- Render's free tier sleeps. The first scan after a while can take about 50 seconds while it wakes up.
