const matchy = /%[0-9.-]*([a-z])/g;
const replacy = /(?<pre>.*?)%(?<num>[0-9.-]+)*(?<formatter>[a-z])/gs;

export const placeholderTypes = (str) => {
  // '%-16s, line %4d, %-16s:ret=%d,broadcast lan_seach to %s:%.3f!!!!'
  // =>
  // [ 's', 'd', 's', 'd', 's', 'f' ]
  return [...str.matchAll(matchy)].map((m) => m[1]);
};
export const sprintf = (str, values) => {
  // '%-16s, line %4d, %-16s:ret=%d,broadcast lan_seach to %s:%.3f!!!!' +
  // ["asd", 20, ...]
  // =>
  // asd, line 20, ...
  const matches = str.matchAll(replacy);
  let lastScanned = 0;
  const s = [...matches]
    .map((m, idx) => {
      const cur = values[idx];
      const val = m.groups.formatter == "x" ? `0x${cur.toString(16)}` : cur.toString();
      lastScanned = m.index + m[0].length;
      return m.groups.pre + val;
    })
    .join("");
  return s + str.slice(lastScanned);
};
export const u32_swap = (x) =>
  ((x & 0xff000000) >> 24) | ((x & 0xff0000) >> 8) | ((x & 0xff00) << 8) | ((x & 0xff) << 24);
export const u16_swap = (x) => ((x & 0xff00) >> 8) | ((x & 0x00ff) << 8);
export const swap_endianness_u16 = (ptr) => {
  const bytes = ptr.readU16();
  const swapped = [(bytes & 0xff00) >> 8, bytes & 0x00ff];
  return swapped;
};
export const swap_endianness_u32 = (ptr) => {
  const bytes = ptr.readU32();
  const swapped = [
    (bytes & 0xff000000) >> 24,
    (bytes & 0x00ff0000) >> 16,
    (bytes & 0x0000ff00) >> 8,
    bytes & 0x000000ff,
  ];
  return swapped;
};

function fallbackCopyTextToClipboard(text) {
  var textArea = document.createElement("textarea");
  textArea.value = text;
  
  // Avoid scrolling to bottom
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    var successful = document.execCommand('copy');
    var msg = successful ? 'successful' : 'unsuccessful';
    console.log('Fallback: Copying text command was ' + msg);
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err);
  }

  document.body.removeChild(textArea);
}
export function copyTextToClipboard(text) {
  if (!navigator.clipboard) {
    fallbackCopyTextToClipboard(text);
    return;
  }
  navigator.clipboard.writeText(text).then(function() {
    console.log('Async: Copying to clipboard was successful!');
  }, function(err) {
    console.error('Async: Could not copy text: ', err);
  });
}