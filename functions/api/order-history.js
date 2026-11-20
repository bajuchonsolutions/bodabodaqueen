export function onRequestGet() {
  return Response.json(
    { success: false, error: "Order history requires verified account access and is temporarily unavailable." },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}
