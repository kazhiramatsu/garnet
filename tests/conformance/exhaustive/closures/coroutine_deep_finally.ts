// More than the historical eight nested coroutine handlers must remain safe.
async function deep(): Promise<string> {
  let log = "";
  try {
    try {
      try {
        try {
          try {
            try {
              try {
                try {
                  try {
                    try {
                      const value = await Promise.resolve(7);
                      return String(value) + log;
                    } finally { log += "a"; }
                  } finally { log += "b"; }
                } finally { log += "c"; }
              } finally { log += "d"; }
            } finally { log += "e"; }
          } finally { log += "f"; }
        } finally { log += "g"; }
      } finally { log += "h"; }
    } finally { log += "i"; }
  } finally {
    console.log(log + "j"); // abcdefghij
  }
}

deep().then((value) => console.log(value)); // 7
