function matlab_bench()
% Same workloads as the Bo and Python versions; prints "name seconds result".
cases = {"loop", @loop; "fib", @() fib(32); "collatz", @collatz; ...
    "pipeline", @pipeline; "pipeline_vectorized", @pipeline_vec; ...
    "loop_vectorized", @loop_vec};
for k = 1:size(cases, 1)
    f = cases{k, 2};
    best = inf;
    for rep = 1:3
        t = tic; r = f(); best = min(best, toc(t));
    end
    fprintf("%s %.4f %d\n", cases{k, 1}, best, r);
end
end

function s = loop()
s = 0; i = 0;
while i < 5000000
    s = s + i; i = i + 1;
end
end

function r = fib(n)
if n < 2
    r = n;
else
    r = fib(n - 1) + fib(n - 2);
end
end

function t = collatz()
t = 0;
for n = 2:30000
    while n > 1
        if mod(n, 2) == 0
            n = floor(n / 2);
        else
            n = 3 * n + 1;
        end
        t = t + 1;
    end
end
end

function s = pipeline()
s = 0;
for y = 1:200000
    x = y * y;
    if mod(x, 2) == 0
        s = s + x;
    end
end
end

function s = pipeline_vec()
a = (1:200000) .^ 2;
s = sum(a(mod(a, 2) == 0));
end

function s = loop_vec()
s = sum(0:4999999);
end
