// Background service worker for DealMachine Scraper Extension

console.log("DealMachine Scraper Background Service Worker loaded");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle scraping action (if needed for future use)
  if (request.action === "startScraping") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url.includes("dealmachine.com")) {
        sendResponse({
          success: false,
          error: "Please navigate to dealmachine.com first.",
        });
        return;
      }

      if (!request.token) {
        sendResponse({
          success: false,
          error: "Missing authentication token.",
        });
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        { action: "executeScraperInContent", token: request.token },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              "Error forwarding to content script:",
              chrome.runtime.lastError
            );
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            sendResponse(response);
          }
        }
      );
    });
    return true; // keep message channel open for async sendResponse
  }

  // Check authentication status
  if (request.action === "checkAuth") {
    chrome.storage.local.get(["jwtToken"], (result) => {
      sendResponse({
        isAuthenticated: !!result.jwtToken,
        token: result.jwtToken,
      });
    });
    return true;
  }

  // Save authentication token
  if (request.action === "saveAuth") {
    chrome.storage.local.set(
      {
        jwtToken: request.token,
        userInfo: request.userInfo,
      },
      () => {
        sendResponse({ success: true });
      }
    );
    return true;
  }

  // Logout action
  if (request.action === "logout") {
    chrome.storage.local.remove(["jwtToken", "userInfo"], () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("DealMachine Scraper Extension installed");
});