browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: "chat.html" });
});
