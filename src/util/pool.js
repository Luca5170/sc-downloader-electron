// 28.10.26

// Helpers for work done in parallel, in place of the threads of the python version

/** Results of action(item) in the same order of the items, at most limit at the same time */
async function map(items, action, limit = 6) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      const index = next++;
      results[index] = await action(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

/** Queue whose get() waits until something is put */
class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  put(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  get() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** One at a time: the work given while another is running waits for it */
class Mutex {
  constructor() {
    this.last = Promise.resolve();
  }

  run(action) {
    const result = this.last.then(() => action());
    this.last = result.catch(() => {});
    return result;
  }
}

/** Wakes a loop that sleeps, like threading.Event */
class Wake {
  constructor() {
    this.resolve = null;
    this.flag = false;
  }

  set() {
    this.flag = true;
    if (this.resolve) this.resolve();
  }

  wait(ms) {
    if (this.flag) {
      this.flag = false;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;

      function done() {
        clearTimeout(timer);
        self.resolve = null;
        self.flag = false;
        resolve();
      }

      this.resolve = done;
    });
  }
}

module.exports = { map, AsyncQueue, Mutex, Wake };
