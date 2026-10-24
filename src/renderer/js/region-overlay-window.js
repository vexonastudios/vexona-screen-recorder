if (window.snapforge) {
  window.snapforge.onRegionInfo((info) => {
    const labelText = document.getElementById("label-text");
    if (labelText && info) {
      labelText.textContent = `REC ${info.width} × ${info.height}`;
    }
  });
}
