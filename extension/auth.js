async function signIn() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + token }
      })
      .then(r => r.json())
      .then(userInfo => {
        const user = {
          id: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture,
          token: token,
          signedInAt: Date.now()
        };
        chrome.storage.local.set({ user });
        resolve(user);
      })
      .catch(reject);
    });
  });
}

async function signOut() {
  return new Promise((resolve) => {
    chrome.storage.local.get('user', (data) => {
      if (data.user?.token) {
        chrome.identity.removeCachedAuthToken({ token: data.user.token }, () => {});
      }
      chrome.storage.local.remove('user');
      resolve();
    });
  });
}

async function getUser() {
  return new Promise((resolve) => {
    chrome.storage.local.get('user', (data) => {
      resolve(data.user || null);
    });
  });
}
