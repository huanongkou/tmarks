// Model origin-wide Web Locks in Node (Chrome provides navigator.locks natively).
const queues = new Map();
Object.defineProperty(navigator, 'locks', { configurable: true, value: {
  request(name, callback) {
    const previous = queues.get(name) || Promise.resolve();
    const task = previous.catch(() => {}).then(callback);
    queues.set(name, task);
    task.finally(() => { if (queues.get(name) === task) queues.delete(name); }).catch(() => {});
    return task;
  },
} });
