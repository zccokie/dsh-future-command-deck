/**
 * Host half of the Future Command Deck bundle.
 *
 * All rendering lives in the Client half (`client.js`), which registers theme
 * token overrides plus three slot entries into the Web page. This Host module
 * exists so the bundle has a loader row of its own: it registers no service,
 * tool, or event, and therefore adds no runtime cost beyond activation.
 */
export function apply() {}
