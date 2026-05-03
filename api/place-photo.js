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

    const googleResponse = await fetch(cleanUrl.toString());

    if (!googleResponse.ok) {
      return res.status(googleResponse.status).send("Failed to fetch image");
    }

    const contentType =
      googleResponse.headers.get("content-type") || "image/jpeg";

    const imageBuffer = await googleResponse.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.send(Buffer.from(imageBuffer));
  } catch (error) {
    console.error("Place photo proxy error:", error);
    return res.status(500).send("Image proxy error");
  }
}
