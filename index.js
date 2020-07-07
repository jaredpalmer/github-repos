const { json } = require('micro');
const fetch = require('node-fetch');
const ms = require('ms');

let cachedRepos = [];

const owners = [
  {
    name: 'jaredpalmer',
    requiredRepos: [
      'razzle',
      'backpack',
      'react-fns',
      'after.js',
      'the-platform',
    ],
  },
  {
    name: 'formik',
    requiredRepos: ['formik', 'tsdx', 'typescript'],
  },
  {
    name: 'palmerhq',
    requiredRepos: ['changecast'],
  },
];

const githubRequestHeaders = {
  headers: {
    Authorization: `token ${process.env.GITHUB_API_KEY}`,
    Accept: 'application/vnd.github.preview',
  },
};

function log(text) {
  return slack(text, process.env.EVENTS_URL);
}

function logError(text) {
  return slack(text, process.env.ERRORS_URL);
}

function slack(text, url) {
  if (process.env.NODE_ENV === 'production') {
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  } else {
    console.log(text);
  }
}

async function cache() {
  const start = Date.now();

  let repos = [];
  for (const owner of owners) {
    try {
      const [response, response2] = await Promise.all([
        fetch(
          `https://api.github.com/users/${owner.name}/repos?type=owner&visibility=public&per_page=100`,
          githubRequestHeaders
        ),
        fetch(
          `https://api.github.com/users/${owner.name}/repos?type=owner&visibility=public&per_page=100&page=2`,
          githubRequestHeaders
        ),
      ]);

      if (response.status !== 200 || response2.status !== 200) {
        logError(
          `Non-200 response code from GitHub: ${
            response.status + ' ' + response2.status !== 200
          }`
        );
        continue;
      }

      const owner1Repos = await response.json();
      const owner2Repos = await response2.json();
      const ownerRepos = [...owner1Repos, ...owner2Repos];

      if (owner.requiredRepos) {
        const requiredCount = ownerRepos.reduce(
          (acc, { name }) =>
            owner.requiredRepos.includes(name) ? acc + 1 : acc,
          0
        );

        if (requiredCount !== owner.requiredRepos.length) {
          logError(
            `Error: GitHub did not include all projects (${requiredCount})`
          );
          continue;
        }
      }

      const filteredRepos = ownerRepos.filter(({ fork }) => !fork);

      const languageRequests = filteredRepos.map(async ({ name }) => {
        try {
          const response = await fetch(
            `https://api.github.com/repos/${owner.name}/${name}/languages`,
            githubRequestHeaders
          );
          const repoLanguages = await response.json();
          return repoLanguages;
        } catch (error) {
          return;
        }
      });

      const languages = await Promise.all(languageRequests);

      repos = [
        ...repos,
        ...filteredRepos.map(
          (
            {
              name,
              description,
              stargazers_count,
              html_url,
              owner: { login: owner },
            },
            index
          ) => ({
            name,
            owner,
            description,
            url: html_url,
            stars: stargazers_count,
            languages: languages[index],
          })
        ),
      ];
    } catch (error) {
      logError('Error parsing response from GitHub: ' + error.stack);
      continue;
    }
  }

  cachedRepos = repos.sort(
    ({ stars: firstStars }, { stars: secondStars }) => secondStars - firstStars
  );

  log(
    `Re-built projects cache.\nTotal: ${
      cachedRepos.length
    } public projects.\nElapsed: ${new Date() - start}ms`
  );
}

cache();
setInterval(cache, ms('15m'));

// micro server
module.exports = async (req, res) => {
  // @todo restrict this to palmer domains?
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  if (req.method === 'POST') {
    const requestedRepoNames = await json(req);

    const requestedRepos = [];
    requestedRepoNames.forEach(({ name, owner }) => {
      requestedRepos.push(
        cachedRepos.find(
          ({ name: cachedName, owner: cachedOwner }) =>
            name === cachedName && owner === cachedOwner
        )
      );
    });

    return requestedRepos;
  } else {
    return cachedRepos;
  }
};
