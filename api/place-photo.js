export default async function handler(req, res) {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).send("Missing photo url");
    }

    const decodedUrl = decodeURIComponent(url);

    const cleanUrl = new URL(decodedUrl);
    cleanUrl.searchParams.delete("key");
    cleanUrl.searchParams.set("key", process.env.GOOGLE_API_KEY);
    // Cap the source size. Cards display ~360–400px wide; 1000px covers retina
    // comfortably while cutting payload vs the stored 1200px. (No-op for legacy
    // URLs that don't use maxWidthPx.)
    cleanUrl.searchParams.set("maxWidthPx", "1000");

    const googleResponse = await fetch(cleanUrl.toString());

    if (!googleResponse.ok) {
      return res.status(googleResponse.status).send("Failed to fetch image");
    }

    const contentType =
      googleResponse.headers.get("content-type") || "image/jpeg";

    const imageBuffer = await googleResponse.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    // Venue photos never change → cache hard. `s-maxage` lets Vercel's edge CDN
    // serve repeats without re-invoking this function or re-hitting Google, so
    // only the very first view of each image pays the round-trip.
    res.setHeader(
      "Cache-Control",
      "public, max-age=31536000, s-maxage=31536000, immutable"
    );

    return res.send(Buffer.from(imageBuffer));
  } catch (error) {
    console.error("Place photo proxy error:", error);
    return res.status(500).send("Image proxy error");
  }
}
